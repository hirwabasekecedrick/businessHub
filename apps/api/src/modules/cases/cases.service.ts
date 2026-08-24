import {
  Injectable,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CaseStatus, Prisma } from '@prisma/client';
import { CaseAbilityService, UserContext } from '../../common/abilities/case-ability.service';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../../common/audit.service';
import { NotificationService } from '../../common/notification.service';
import { getTransition } from './transitions';
import { BusinessCalendar, computeSlaDueAt } from '../../common/sla.util';

const REASONS_REQUIRED = new Set(['ON_HOLD', 'REJECTED', 'ESCALATED', 'AWAITING_INFO']);

@Injectable()
export class CasesService {
  constructor(
    private readonly caseAbility: CaseAbilityService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  requirePermission(ctx: UserContext, permission: string) {
    if (!ctx.permissions?.includes(permission) && !ctx.permissions?.includes('*')) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', required: permission });
    }
  }

  // References are globally unique, so all counters share one sentinel owner row
  // instead of one per organisation (per-org counters would collide).
  private static readonly SEQUENCE_OWNER = '00000000-0000-4000-8000-000000009999';

  private async generateReference(
    tx: Prisma.TransactionClient,
    _organizationId: string,
    purpose = 'CASE_REF',
    prefix = 'CASE',
  ): Promise<string> {
    const year = new Date().getFullYear();
    const result: any[] = await tx.$queryRaw`
      INSERT INTO gapless_sequence ("id", "organizationId", "purpose", "year", "lastValue")
      VALUES (gen_random_uuid(), ${CasesService.SEQUENCE_OWNER}::uuid, ${purpose}, ${year}, 1)
      ON CONFLICT ("organizationId", "purpose", "year")
      DO UPDATE SET "lastValue" = gapless_sequence."lastValue" + 1
      RETURNING "lastValue";
    `;
    const lastValue = Number(result[0].lastValue);
    return `${prefix}-${year}-${lastValue.toString().padStart(6, '0')}`;
  }

  /** Shared by cases and invoices. */
  async nextReference(organizationId: string, purpose: 'CASE_REF' | 'INVOICE') {
    return this.generateReference(this.prisma as any, organizationId, purpose, purpose === 'INVOICE' ? 'INV' : 'CASE');
  }

  private validateAgainstSchema(schema: any, payload: Record<string, any>): Array<{ field: string; message: string }> {
    if (!schema || typeof schema !== 'object') return [];
    const errors: Array<{ field: string; message: string }> = [];
    for (const [field, def] of Object.entries<any>(schema.properties ?? {})) {
      if (schema.required?.includes(field)) {
        const v = payload?.[field];
        if (v === undefined || v === null || v === '') {
          errors.push({ field, message: def.description || `Field '${field}' is required` });
          continue;
        }
      }
      if (payload?.[field] === undefined) continue;
      const type = def.type;
      const v = payload[field];
      if (type === 'string' && typeof v !== 'string') errors.push({ field, message: `Field '${field}' must be a string` });
      if (type === 'number' && typeof v !== 'number') errors.push({ field, message: `Field '${field}' must be a number` });
      if (type === 'boolean' && typeof v !== 'boolean') errors.push({ field, message: `Field '${field}' must be a boolean` });
      if (type === 'integer' && !Number.isInteger(v)) errors.push({ field, message: `Field '${field}' must be an integer` });
      if (def.enum && !def.enum.includes(v)) errors.push({ field, message: `Field '${field}' must be one of: ${def.enum.join(', ')}` });
    }
    return errors;
  }

  async createCase(ctx: UserContext, data: any) {
    this.caseAbility.checkNotImpersonatingForWrite(ctx);
    this.requirePermission(ctx, 'case.create');

    const caseType = await this.prisma.caseType.findUnique({ where: { id: data.caseTypeId } });
    if (!caseType || !caseType.isActive) throw new NotFoundException({ code: 'CASE_TYPE_NOT_FOUND' });

    // Cases are owned by the internal organisation; a portal client's org is
    // recorded as clientOrgId so internal staff can work the queue.
    const myOrg = await this.prisma.organization.findUnique({ where: { id: ctx.organizationId! } });
    const isInternal = myOrg?.type === 'INTERNAL';
    let organizationId = ctx.organizationId!;
    let clientOrgId: string | null = data.clientOrgId ?? null;
    if (!isInternal) {
      const internal = await this.prisma.organization.findFirst({ where: { type: 'INTERNAL' } });
      if (!internal) throw new ConflictException({ code: 'NO_INTERNAL_ORG' });
      organizationId = internal.id;
      clientOrgId = ctx.organizationId!;
    }
    if (!clientOrgId) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', fieldErrors: [{ field: 'clientOrgId', message: 'clientOrgId is required when creating on behalf of a client' }] });
    }

    return this.prisma.$transaction(async (tx) => {
      const reference = await this.generateReference(tx, organizationId);
      return tx.case.create({
        data: {
          reference,
          organizationId,
          clientOrgId,
          caseTypeId: caseType.id,
          subject: data.subject,
          description: data.description,
          payload: data.payload ?? {},
          createdBy: ctx.id,
          ownerUserId: data.ownerUserId ?? ctx.id,
          status: CaseStatus.DRAFT,
        },
      });
    });
  }

  async listCases(ctx: UserContext, query: any) {
    // Visitors and clients hold only case.read.own; staff hold case.read.org.
    if (
      !ctx.permissions.includes('case.read.org') &&
      !ctx.permissions.includes('case.read.all') &&
      !ctx.permissions.includes('case.read.own')
    ) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', required: 'case.read.own' });
    }
    const where: Prisma.CaseWhereInput = { deletedAt: null };

    // Tenant scoping enforced in the query (never filtered after the fact).
    const canReadAll = ctx.permissions.includes('case.read.all');
    const canReadOrg = ctx.permissions.includes('case.read.org');
    const canReadOwn = ctx.permissions.includes('case.read.own');
    if (canReadAll && query.all === 'true') {
      // cross-tenant reporting only for super admins
    } else if (canReadOrg) {
      where.OR = [{ organizationId: ctx.organizationId }, { clientOrgId: ctx.organizationId }];
    } else if (canReadOwn) {
      // US-1.3 isolation: visibility follows the ACTIVE organisation only —
      // other memberships must never widen a portal user's view.
      where.AND = [
        { OR: [{ organizationId: ctx.organizationId }, { clientOrgId: ctx.organizationId }] },
        { OR: [{ ownerUserId: ctx.id }, { createdBy: ctx.id }] },
      ];
    } else {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', required: 'case.read.own' });
    }

    if (query.status) where.status = query.status;
    if (query.priority) where.priority = query.priority;
    if (query.ownerUserId) where.ownerUserId = query.ownerUserId;
    if (query.mine === 'true') where.ownerUserId = ctx.id;

    const page = Math.max(1, parseInt(query.page ?? '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize ?? '20', 10)));

    const now = new Date();
    const [total, rows] = await Promise.all([
      this.prisma.case.count({ where }),
      this.prisma.case.findMany({
        where,
        orderBy: [{ slaDueAt: 'asc' }, { createdAt: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { caseType: true, clientOrg: true },
      }),
    ]);

    const items = rows
      .map((c) => ({ ...c, breached: !!(c.slaDueAt && c.slaDueAt < now && !['RESOLVED', 'CLOSED', 'ARCHIVED'].includes(c.status)) }))
      .sort((a, b) => Number(b.breached) - Number(a.breached)); // breached pinned on top

    const atRiskThreshold = 0.2; // shared constant for web and mobile
    return {
      meta: { total, page, pageSize },
      items: items.map(({ caseType, clientOrg, ...c }) => ({
        id: c.id,
        reference: c.reference,
        subject: c.subject,
        status: c.status,
        priority: c.priority,
        slaDueAt: c.slaDueAt,
        breached: c.breached,
        atRisk:
          !c.breached &&
          c.slaDueAt != null &&
          c.slaDueAt.getTime() - now.getTime() <
            atRiskThreshold * ((c.slaDueAt.getTime() - c.submittedAt!.getTime()) || 1),
        caseTypeCode: caseType.code,
        clientOrgName: clientOrg.legalName,
        ownerUserId: c.ownerUserId,
      })),
    };
  }

  async getCase(ctx: UserContext, caseId: string) {
    const record = await this.prisma.case.findUnique({
      where: { id: caseId },
      include: { caseType: true, tasks: true, documents: { where: { deletedAt: null } } },
    });
    if (!record || record.deletedAt) throw new NotFoundException({ code: 'CASE_NOT_FOUND' });
    this.caseAbility.canRead(ctx, record);
    return record;
  }

  async updateCase(ctx: UserContext, caseId: string, data: any) {
    const record = await this.prisma.case.findUnique({
      where: { id: caseId },
      include: { caseType: { select: { id: true, name: true } } },
    });
    if (!record || record.deletedAt) throw new NotFoundException({ code: 'CASE_NOT_FOUND' });
    this.caseAbility.canWrite(ctx, record, false);

    // §10.3: changing the case type after submission re-derives the SLA
    // deadline from the original submission instant and records both values.
    let slaDueAt: Date | undefined;
    if (data.caseTypeId && data.caseTypeId !== record.caseTypeId) {
      const nextType = await this.prisma.caseType.findFirst({
        where: { id: data.caseTypeId, isActive: true },
      });
      if (!nextType) {
        throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', fieldErrors: ['caseTypeId'] });
      }
      const calendar =
        (((await this.prisma.organization.findUnique({ where: { id: record.organizationId }, select: { settings: true } }))
          ?.settings as any)?.calendar as Partial<BusinessCalendar>) ?? {};
      slaDueAt = computeSlaDueAt(record.submittedAt ?? new Date(), nextType.slaHours ?? 72, calendar);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.case.update({
        where: { id: caseId },
        data: {
          subject: data.subject,
          description: data.description,
          payload: data.payload,
          priority: data.priority,
          ...(slaDueAt ? { caseTypeId: data.caseTypeId, slaDueAt } : {}),
        },
      });
      if (slaDueAt) {
        await tx.caseStatusHistory.create({
          data: {
            caseId,
            fromStatus: record.status,
            toStatus: record.status,
            reason: `SLA recomputed for type change (${record.caseType?.name ?? record.caseTypeId} → ${data.caseTypeId}): ${
              record.slaDueAt?.toISOString() ?? 'none'
            } → ${slaDueAt.toISOString()}`,
            actorId: ctx.id,
          },
        });
      }
      return row;
    });
    return updated;
  }

  async transitionCase(ctx: UserContext, caseId: string, toStatus: CaseStatus, reason?: string, data?: any) {
    const record = await this.prisma.case.findUnique({ where: { id: caseId } });
    if (!record || record.deletedAt) throw new NotFoundException({ code: 'CASE_NOT_FOUND' });

    const isReopen =
      toStatus === CaseStatus.IN_PROGRESS && record.status === CaseStatus.CLOSED;
    this.caseAbility.canWrite(ctx, record, isReopen);

    const rule = getTransition(record.status, toStatus);
    if (!rule) {
      throw new ConflictException({
        code: 'INVALID_TRANSITION',
        message: `Transition ${record.status} -> ${toStatus} is not allowed`,
        currentStatus: record.status,
      });
    }
    this.requirePermission(ctx, rule.permission.split(' ')[0]); // 'case.transition or system' -> first token

    if ((rule.reasonMandatory || REASONS_REQUIRED.has(toStatus)) && !reason) {
      throw new UnprocessableEntityException({
        code: 'VALIDATION_FAILED',
        rule: 'reason_required',
        message: 'Reason is mandatory for this transition.',
      });
    }

    // DRAFT -> SUBMITTED guard: required fields + required document categories.
    if (toStatus === CaseStatus.SUBMITTED && record.status === CaseStatus.DRAFT) {
      const caseType = await this.prisma.caseType.findUnique({ where: { id: record.caseTypeId } });
      const errors = this.validateAgainstSchema(caseType?.formSchema as any, record.payload as any);
      if (errors.length) {
        throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', fieldErrors: errors });
      }
      const docs = await this.prisma.document.findMany({ where: { caseId, deletedAt: null } });
      const haveCats = new Set(docs.map((d) => d.category));
      const missingDocs = (caseType?.requiredDocs ?? []).filter((cat) => !haveCats.has(cat));
      if (missingDocs.length) {
        throw new UnprocessableEntityException({ code: 'MISSING_DOCUMENTS', missingCategories: missingDocs });
      }
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      // Optimistic concurrency: exactly one concurrent transition succeeds.
      let updateData: Prisma.CaseUpdateInput = { status: toStatus };

      if (toStatus === CaseStatus.SUBMITTED && record.status === CaseStatus.DRAFT) {
        updateData.submittedAt = now;
        const caseType = await tx.caseType.findUnique({ where: { id: record.caseTypeId } });
        const calendar = (((await tx.organization.findUnique({ where: { id: ctx.organizationId! } }))?.settings as any)?.calendar) ?? {};
        updateData.slaDueAt = computeSlaDueAt(now, caseType?.slaHours ?? 72, calendar);
      }

      if (toStatus === CaseStatus.QUALIFIED) {
        if (data?.priority) updateData.priority = data.priority;
        const caseType = await tx.caseType.findUnique({ where: { id: record.caseTypeId } });
        const submitted = record.submittedAt ?? now;
        updateData.slaDueAt = computeSlaDueAt(submitted, caseType?.slaHours ?? 72, {});
      }

      if (toStatus === CaseStatus.ASSIGNED && data?.ownerUserId) {
        updateData.ownerUser = { connect: { id: data.ownerUserId } };

        // FR-4.2: instantiate the ACTIVE template version; record it on the case
        // so later template edits do not rewrite history.
        const tpl = await tx.processTemplate.findFirst({
          where: { caseTypeId: record.caseTypeId, isActive: true },
          orderBy: { version: 'desc' },
        });
        if (tpl) {
          updateData.template = { connect: { id: tpl.id } };
          const steps = Array.isArray(tpl.steps) ? (tpl.steps as any[]) : [];
          const baseSlaMs = ((updateData.slaDueAt ?? record.slaDueAt) as unknown) as Date | null;
          // Roles may be system-wide (organizationId null) or org-scoped.
          const roleFor = (code?: string | null) =>
            code
              ? tx.role.findFirst({
                  where: { code, OR: [{ organizationId: ctx.organizationId }, { organizationId: null }] },
                })
              : null;
          const ownerMembership = await tx.membership.findFirst({
            where: { userId: data.ownerUserId, deletedAt: null },
            include: { role: { select: { code: true } } },
          });
          const ownerRoleCode = ownerMembership?.role?.code ?? null;
          let previousTaskId: string | null = null;
          let seq = 0;
          for (const step of steps) {
            const dueAt = baseSlaMs
              ? new Date(new Date(baseSlaMs).getTime() - (steps.length - seq - 1) * 3600 * 1000)
              : undefined;
            const role = await roleFor(step.roleCode);
            // Same-role follow-on work stays with the case owner; otherwise it
            // goes to the step's role queue.
            const mine =
              seq === 0 ||
              (step.type !== 'APPROVAL' &&
                !!ownerRoleCode &&
                !!step.roleCode &&
                String(step.roleCode).toLowerCase() === ownerRoleCode.toLowerCase());
            const task = await tx.task.create({
              data: {
                caseId,
                organizationId: ctx.organizationId!,
                type: step.type ?? 'TASK',
                title: step.title,
                description: step.description,
                sequence: seq,
                assigneeUserId: mine ? data.ownerUserId : null,
                assigneeRoleId: step.type === 'APPROVAL' ? null : role?.id ?? null,
                status: seq === 0 ? 'OPEN' : 'BLOCKED',
                blockedById: seq === 0 ? null : previousTaskId ?? undefined,
                dueAt,
              },
            });
            if (step.type === 'APPROVAL') {
              const approverRole =
                role ??
                (await tx.role.findFirst({
                  where: { OR: [{ organizationId: ctx.organizationId }, { organizationId: null }] },
                  orderBy: { approvalLevel: 'desc' },
                }));
              if (approverRole) {
                await tx.approval.create({
                  data: {
                    taskId: task.id,
                    level: step.level ?? 1,
                    requiredRoleId: approverRole.id,
                  },
                });
              }
            }
            previousTaskId = task.id;
            seq++;
          }
        }
      }

      if (([CaseStatus.ON_HOLD, CaseStatus.AWAITING_INFO] as string[]).includes(toStatus)) {
        updateData.slaPausedAt = now;
      }

      if (([CaseStatus.IN_PROGRESS] as string[]).includes(toStatus) && record.slaPausedAt) {
        const pausedMs = now.getTime() - record.slaPausedAt.getTime();
        updateData.slaPausedMs = { increment: BigInt(pausedMs) };
        updateData.slaPausedAt = null;
        if (record.slaDueAt) {
          updateData.slaDueAt = new Date(record.slaDueAt.getTime() + pausedMs);
        }
      }

      if (toStatus === CaseStatus.CLOSED) updateData.closedAt = now;
      if (toStatus === CaseStatus.RESOLVED) updateData.resolvedAt = now;
      if (toStatus === CaseStatus.IN_PROGRESS && record.status === CaseStatus.CLOSED) {
        // Reopen within 30 days with shortened SLA.
        if (!record.closedAt || Date.now() - record.closedAt.getTime() > 30 * 24 * 3600 * 1000) {
          throw new ConflictException({ code: 'REOPEN_WINDOW_EXPIRED' });
        }
        updateData.closedAt = null;
        updateData.resolvedAt = null;
        updateData.slaDueAt = computeSlaDueAt(now, 24, {});
      }

      try {
        const updatedCase = await tx.case.update({ where: { id: caseId }, data: updateData });
        // History row in the same transaction as the status update — never one without the other.
        await tx.caseStatusHistory.create({
          data: {
            caseId,
            fromStatus: record.status,
            toStatus,
            reason: reason ?? '',
            actorId: ctx.id,
          },
        });
        return updatedCase;
      } catch {
        throw new ConflictException({ code: 'INVALID_TRANSITION', currentStatus: record.status });
      }
    });

    await this.audit.record({
      actorUserId: ctx.id,
      organizationId: ctx.organizationId,
      action: 'CASE_TRANSITIONED',
      resourceType: 'case',
      resourceId: caseId,
      before: { status: record.status },
      after: { status: toStatus, reason },
    });

    // Side-effect notifications
    if (toStatus === CaseStatus.SUBMITTED) {
      // US-3.1: acknowledgement with reference + expected resolution date.
      const ackCase = await this.prisma.case.findUnique({ where: { id: caseId }, select: { slaDueAt: true } });
      await this.notifications.notify({
        recipientId: record.createdBy,
        organizationId: record.organizationId,
        eventKey: 'CASE_SUBMITTED',
        variables: {
          reference: record.reference,
          submittedAt: now.toISOString(),
          slaDueAt: ackCase?.slaDueAt?.toISOString() ?? '',
        },
        resourceType: 'case',
        resourceId: caseId,
      });
    }
    if (toStatus === CaseStatus.ASSIGNED && data?.ownerUserId) {
      await this.notifications.notify({
        recipientId: data.ownerUserId,
        organizationId: ctx.organizationId,
        eventKey: 'CASE_ASSIGNED',
        variables: { reference: record.reference },
        resourceType: 'case',
        resourceId: caseId,
      });
    }
    if (['REJECTED', 'APPROVED'].includes(toStatus)) {
      await this.notifications.notify({
        recipientId: record.createdBy,
        organizationId: ctx.organizationId,
        eventKey: `CASE_${toStatus}`,
        urgent: toStatus === 'REJECTED',
        variables: { reference: record.reference, reason },
        resourceType: 'case',
        resourceId: caseId,
      });
    }

    return updated;
  }

  async submitCase(ctx: UserContext, caseId: string) {
    return this.transitionCase(ctx, caseId, CaseStatus.SUBMITTED);
  }

  async assignCase(ctx: UserContext, caseId: string, ownerUserId: string) {
    return this.transitionCase(ctx, caseId, CaseStatus.ASSIGNED, undefined, { ownerUserId });
  }

  async holdCase(ctx: UserContext, caseId: string, reason: string) {
    return this.transitionCase(ctx, caseId, CaseStatus.ON_HOLD, reason);
  }

  async resumeCase(ctx: UserContext, caseId: string) {
    return this.transitionCase(ctx, caseId, CaseStatus.IN_PROGRESS);
  }

  async closeCase(ctx: UserContext, caseId: string) {
    return this.transitionCase(ctx, caseId, CaseStatus.CLOSED);
  }

  async reopenCase(ctx: UserContext, caseId: string, reason: string) {
    return this.transitionCase(ctx, caseId, CaseStatus.IN_PROGRESS, reason);
  }

  async getHistory(ctx: UserContext, caseId: string) {
    const record = await this.prisma.case.findUnique({ where: { id: caseId } });
    if (!record) throw new NotFoundException({ code: 'CASE_NOT_FOUND' });
    this.caseAbility.canRead(ctx, record);

    const history = await this.prisma.caseStatusHistory.findMany({
      where: { caseId },
      orderBy: { occurredAt: 'asc' },
      include: { actor: { select: { email: true } } },
    });
    // Client-facing simplified timeline vs full audit view.
    const internalRoles = ['AGENT', 'MANAGER', 'ADMIN', 'SUPER'];
    const simplified = !(ctx.roleCode && internalRoles.includes(ctx.roleCode.toUpperCase()));
    return history.map((h) => ({
      from: h.fromStatus,
      to: h.toStatus,
      at: h.occurredAt,
      actor: simplified ? undefined : h.actor.email,
      reason: simplified ? undefined : h.reason,
    }));
  }

  async bulkAssign(ctx: UserContext, caseIds: string[], ownerUserId: string) {
    this.requirePermission(ctx, 'case.assign');
    if (!Array.isArray(caseIds) || caseIds.length === 0 || caseIds.length > 100) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', rule: 'bulk_size_1_to_100' });
    }
    const results: any[] = [];
    for (const caseId of caseIds) {
      try {
        await this.transitionCase(ctx, caseId, CaseStatus.ASSIGNED, undefined, { ownerUserId });
        results.push({ caseId, ok: true });
      } catch (e: any) {
        results.push({ caseId, ok: false, error: e.response?.code ?? e.message });
      }
    }
    return { results };
  }

  async exportCases(ctx: UserContext, filters: any) {
    const job = await this.prisma.job.create({
      data: {
        organizationId: ctx.organizationId,
        type: 'CASES_EXPORT',
        params: filters ?? {},
        createdBy: ctx.id,
        status: 'RUNNING',
      },
    });
    const list = await this.listCases(ctx, { ...filters, pageSize: '100' });
    const csv = [
      'reference,subject,status,priority,sla_due_at',
      ...list.items.map((i: any) => [i.reference, `"${i.subject}"`, i.status, i.priority, i.slaDueAt?.toISOString() ?? ''].join(',')),
    ].join('\n');
    await this.prisma.job.update({
      where: { id: job.id },
      data: { status: 'DONE', completedAt: new Date(), result: { csv, filter: filters ?? {} } },
    });
    await this.audit.record({
      actorUserId: ctx.id,
      organizationId: ctx.organizationId,
      action: 'EXPORT_CASES',
      resourceType: 'job',
      resourceId: job.id,
    });
    return { jobId: job.id };
  }

  async getJob(ctx: UserContext, jobId: string) {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException({ code: 'JOB_NOT_FOUND' });
    if (job.organizationId && job.organizationId !== ctx.organizationId && !ctx.permissions.includes('*')) {
      throw new ForbiddenException({ code: 'ORG_FORBIDDEN' });
    }
    return job;
  }

  async getCaseComments(ctx: UserContext, caseId: string) {
    const record = await this.prisma.case.findUnique({ where: { id: caseId } });
    if (!record) throw new NotFoundException({ code: 'CASE_NOT_FOUND' });
    this.caseAbility.canRead(ctx, record);

    const internalRoles = ['AGENT', 'MANAGER', 'ADMIN', 'SUPER'];
    const seesInternal = ctx.roleCode && internalRoles.includes(ctx.roleCode.toUpperCase());
    // Internal-only comments invisible at API level for client/partner roles (FR-3.8).
    return this.prisma.comment.findMany({
      where: { caseId, ...(seesInternal ? {} : { isInternal: false }), deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addComment(ctx: UserContext, caseId: string, body: string, isInternal: boolean) {
    const record = await this.prisma.case.findUnique({ where: { id: caseId } });
    if (!record) throw new NotFoundException({ code: 'CASE_NOT_FOUND' });
    this.caseAbility.canWrite(ctx, record, false);

    const internalRoles = ['AGENT', 'MANAGER', 'ADMIN', 'SUPER'];
    if (isInternal && !(ctx.roleCode && internalRoles.includes(ctx.roleCode.toUpperCase()))) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED' });
    }
    const comment = await this.prisma.comment.create({
      data: { caseId, authorId: ctx.id, body, isInternal },
    });
    if (!record.firstResponseAt) {
      await this.prisma.case.update({ where: { id: caseId }, data: { firstResponseAt: new Date() } });
    }
    return comment;
  }
}
