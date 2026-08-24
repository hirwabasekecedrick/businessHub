import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApprovalState, Prisma, TaskStatus } from '@prisma/client';
import { UserContext } from '../../common/abilities/case-ability.service';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../../common/audit.service';
import { NotificationService } from '../../common/notification.service';
import { BusinessCalendar, workingMsBetween } from '../../common/sla.util';

@Injectable()
export class WorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  requirePermission(ctx: UserContext, permission: string) {
    if (!ctx.permissions?.includes(permission) && !ctx.permissions?.includes('*')) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', required: permission });
    }
  }

  async getTasks(ctx: UserContext, assigneeMe?: boolean) {
    const where: Prisma.TaskWhereInput = { organizationId: ctx.organizationId };
    if (assigneeMe) {
      where.OR = [{ assigneeUserId: ctx.id }, { AND: [{ assigneeUserId: null }, { assigneeRoleId: { not: null } }] }];
      where.status = { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED] };
    }
    return this.prisma.task.findMany({
      where,
      orderBy: [{ dueAt: 'asc' }],
      include: { case: { select: { reference: true, subject: true } } },
    });
  }

  async createTask(ctx: UserContext, data: any) {
    this.requirePermission(ctx, 'task.create');
    return this.prisma.task.create({
      data: {
        caseId: data.caseId,
        organizationId: ctx.organizationId!,
        type: data.type || 'ADHOC',
        title: data.title,
        description: data.description,
        assigneeUserId: data.assigneeUserId,
        assigneeRoleId: data.assigneeRoleId,
        dueAt: data.dueAt ? new Date(data.dueAt) : undefined,
        blockedById: data.blockedById,
        status: data.blockedById ? TaskStatus.BLOCKED : TaskStatus.OPEN,
      },
    });
  }

  async updateTask(ctx: UserContext, taskId: string, data: any) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException({ code: 'TASK_NOT_FOUND' });
    this.requirePermission(ctx, 'task.create');
    return this.prisma.task.update({
      where: { id: taskId },
      data: {
        title: data.title,
        description: data.description,
        dueAt: data.dueAt ? new Date(data.dueAt) : undefined,
      },
    });
  }

  async claimTask(ctx: UserContext, taskId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException({ code: 'TASK_NOT_FOUND' });
    if (task.assigneeUserId) throw new UnprocessableEntityException({ code: 'TASK_ALREADY_CLAIMED' });

    // Claimant must hold the queue's role.
    if (task.assigneeRoleId) {
      const holdsRole = await this.prisma.membership.findFirst({
        where: { userId: ctx.id, roleId: task.assigneeRoleId, deletedAt: null },
      });
      if (!holdsRole) throw new ForbiddenException({ code: 'PERMISSION_DENIED', required: 'role_of_queue' });
    }
    return this.prisma.task.update({
      where: { id: taskId },
      data: { assigneeUserId: ctx.id, status: TaskStatus.IN_PROGRESS, startedAt: new Date() },
    });
  }

  async reassignTask(ctx: UserContext, taskId: string, assigneeUserId: string, reason?: string) {
    this.requirePermission(ctx, 'task.reassign');
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException({ code: 'TASK_NOT_FOUND' });
    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: { assigneeUserId },
    });
    await this.audit.record({
      actorUserId: ctx.id,
      organizationId: ctx.organizationId,
      action: 'TASK_REASSIGNED',
      resourceType: 'task',
      resourceId: taskId,
      before: { assigneeUserId: task.assigneeUserId },
      after: { assigneeUserId, reason },
    });
    return updated;
  }

  /** FR-4.5 / US-4.1: completing a task unblocks the next one and notifies its assignee. */
  async completeTask(ctx: UserContext, taskId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException({ code: 'TASK_NOT_FOUND' });
    if (
      task.assigneeUserId !== ctx.id &&
      !ctx.permissions.includes('task.reassign') &&
      !ctx.permissions.includes('*')
    ) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED' });
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.task.update({
        where: { id: taskId },
        data: { status: TaskStatus.DONE, completedAt: new Date(), assigneeUserId: task.assigneeUserId ?? ctx.id },
      });

      const nextTask = await tx.task.findFirst({
        where: { caseId: task.caseId, blockedById: taskId },
      });
      let unblocked: any = null;
      if (nextTask) {
        unblocked = await tx.task.update({
          where: { id: nextTask.id },
          data: { status: TaskStatus.OPEN },
        });
      }

      const openLeft = await tx.task.count({
        where: { caseId: task.caseId, status: { in: [TaskStatus.OPEN, TaskStatus.IN_PROGRESS, TaskStatus.BLOCKED] }, id: { not: updated.id } },
      });
      void openLeft;

      return { completed: updated, unblocked };
    }).then(async (res) => {
      if (res.unblocked?.assigneeUserId) {
        await this.notifications.notify({
          recipientId: res.unblocked.assigneeUserId,
          organizationId: ctx.organizationId,
          eventKey: 'TASK_UNBLOCKED',
          variables: { title: res.unblocked.title },
          resourceType: 'case',
          resourceId: res.unblocked.caseId,
        });
      }
      return { completed: res.completed, unblocked: res.unblocked };
    });
  }

  async blockTask(ctx: UserContext, taskId: string, reason: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException({ code: 'TASK_NOT_FOUND' });
    await this.audit.record({
      actorUserId: ctx.id,
      action: 'TASK_BLOCKED',
      resourceType: 'task',
      resourceId: taskId,
      after: { reason },
    });
    return this.prisma.task.update({ where: { id: taskId }, data: { status: TaskStatus.BLOCKED } });
  }

  async getApprovals(ctx: UserContext) {
    const approvals = await this.prisma.approval.findMany({
      where: { state: { in: [ApprovalState.PENDING, ApprovalState.DELEGATED] } },
      orderBy: { createdAt: 'asc' },
      include: {
        task: { include: { case: { select: { reference: true, subject: true } } } },
        requiredRole: true,
      },
    });
    // Only show what this user may see/decide: own-level approvals plus items
    // delegated to them.
    return approvals.filter(
      (a) =>
        ctx.permissions.includes('approval.read') &&
        (a.delegatedToId === ctx.id || ((ctx.approvalLevel ?? 0) >= a.level && a.state === ApprovalState.PENDING)),
    );
  }

  /**
   * US-4.2: a level may only be decided by a user at or above its approval level.
   * Final approve moves the case IN_REVIEW -> APPROVED; any reject -> REJECTED.
   */
  async decideApproval(ctx: UserContext, approvalId: string, decision: 'APPROVED' | 'REJECTED', comment?: string, isOverride = false) {
    this.requirePermission(ctx, isOverride ? 'approval.override' : 'approval.decide');
    if (decision === 'REJECTED' && !comment) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', rule: 'reason_required' });
    }
    if (ctx.isImpersonating) throw new ForbiddenException({ code: 'IMPERSONATION_READ_ONLY' });

    const approval = await this.prisma.approval.findUnique({
      where: { id: approvalId },
      include: { task: { include: { case: true } } },
    });
    if (!approval) throw new NotFoundException({ code: 'APPROVAL_NOT_FOUND' });

    const isDelegate = approval.delegatedToId === ctx.id;
    if (!isDelegate && (ctx.approvalLevel ?? 0) < approval.level) {
      throw new ForbiddenException({
        code: 'APPROVAL_LEVEL_TOO_LOW',
        requiredLevel: approval.level,
        yourLevel: ctx.approvalLevel ?? 0,
      });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const updatedApproval = await tx.approval.update({
        where: { id: approvalId },
        data: {
          state: decision === 'APPROVED' ? ApprovalState.APPROVED : ApprovalState.REJECTED,
          decidedById: ctx.id,
          decidedAt: new Date(),
          comment: isOverride ? `OVERRIDE: ${comment}` : comment,
        },
      });

      if (decision === 'REJECTED') {
        // Cancel every remaining pending level on the case, not just this task.
        const caseTaskIds = await tx.task.findMany({
          where: { caseId: approval.task.caseId },
          select: { id: true },
        });
        await tx.approval.updateMany({
          where: {
            taskId: { in: caseTaskIds.map((t) => t.id) },
            id: { not: approvalId },
            state: ApprovalState.PENDING,
          },
          data: { state: ApprovalState.REJECTED, comment: 'Auto-cancelled due to rejection at an earlier level' },
        });
      }
      return updatedApproval;
    });

    const kase = approval.task.case;
    if (!kase) {
      throw new NotFoundException({ code: 'CASE_NOT_FOUND' });
    }
    if (decision === 'REJECTED') {
      await this.applyCaseTransition(kase.id, kase.status, 'REJECTED', comment ?? '', ctx.id);
      await this.notifications.notify({
        recipientId: kase.createdBy,
        organizationId: kase.organizationId,
        eventKey: 'CASE_REJECTED',
        urgent: true,
        variables: { reference: kase.reference, reason: comment },
        resourceType: 'case',
        resourceId: kase.id,
      });
    } else {
      const nextPending = await this.prisma.approval.findFirst({
        where: { taskId: approval.taskId, state: ApprovalState.PENDING },
      });
      if (!nextPending) {
        await this.applyCaseTransition(kase.id, kase.status, 'APPROVED', comment ?? '', ctx.id);
        await this.notifications.notify({
          recipientId: kase.createdBy,
          organizationId: kase.organizationId,
          eventKey: 'CASE_APPROVED',
          variables: { reference: kase.reference },
          resourceType: 'case',
          resourceId: kase.id,
        });
      }
    }

    await this.audit.record({
      actorUserId: ctx.id,
      effectiveUserId: isDelegate ? approval.delegatedToId : undefined,
      organizationId: ctx.organizationId,
      action: isOverride ? 'APPROVAL_OVERRIDDEN' : 'APPROVAL_DECIDED',
      resourceType: 'approval',
      resourceId: approvalId,
      after: { decision, comment, level: approval.level },
    });

    return result;
  }

  private async applyCaseTransition(caseId: string, from: string, to: string, reason: string, actorId: string) {
    const kase = await this.prisma.case.findUnique({ where: { id: caseId } });
    if (!kase || kase.status !== from) return;
    await this.prisma.$transaction([
      this.prisma.case.update({ where: { id: caseId }, data: { status: to as any } }),
      this.prisma.caseStatusHistory.create({
        data: { caseId, fromStatus: from as any, toStatus: to as any, reason, actorId },
      }),
    ]);
  }

  /** US-4.4: delegation to a peer, bounded period, audited. */
  async delegateApproval(ctx: UserContext, approvalId: string, delegatedToId: string, until?: string) {
    const approval = await this.prisma.approval.findUnique({ where: { id: approvalId } });
    if (!approval) throw new NotFoundException({ code: 'APPROVAL_NOT_FOUND' });
    if ((ctx.approvalLevel ?? 0) < approval.level && approval.delegatedToId !== ctx.id) {
      throw new ForbiddenException({ code: 'APPROVAL_LEVEL_TOO_LOW', requiredLevel: approval.level });
    }
    const expiresAt = until ? new Date(until) : new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const updated = await this.prisma.approval.update({
      where: { id: approvalId },
      data: { delegatedToId, state: ApprovalState.DELEGATED, expiresAt },
    });
    await this.audit.record({
      actorUserId: ctx.id,
      effectiveUserId: delegatedToId,
      action: 'APPROVAL_DELEGATED',
      resourceType: 'approval',
      resourceId: approvalId,
      after: { delegatedToId, expiresAt },
    });
    return updated;
  }

  overrideApproval(ctx: UserContext, approvalId: string, decision: 'APPROVED' | 'REJECTED', comment?: string) {
    return this.decideApproval(ctx, approvalId, decision, comment, true);
  }

  // ---------- PROCESS TEMPLATES ----------

  async listTemplates(ctx: UserContext, caseTypeId?: string) {
    return this.prisma.processTemplate.findMany({
      where: { ...(caseTypeId ? { caseTypeId } : {}) },
      orderBy: [{ caseTypeId: 'asc' }, { version: 'desc' }],
    });
  }

  async createTemplate(ctx: UserContext, data: any) {
    this.requirePermission(ctx, 'admin.reference.manage');
    const latest = await this.prisma.processTemplate.findFirst({
      where: { caseTypeId: data.caseTypeId },
      orderBy: { version: 'desc' },
    });
    return this.prisma.processTemplate.create({
      data: {
        caseTypeId: data.caseTypeId,
        name: data.name,
        steps: data.steps ?? [],
        version: (latest?.version ?? 0) + 1,
        isActive: true,
      },
    });
  }

  // ---------- ESCALATIONS ----------

  async listEscalationRules(ctx: UserContext) {
    return this.prisma.escalationRule.findMany({ where: { isActive: true } });
  }

  async upsertEscalationRule(ctx: UserContext, id: string | undefined, data: any) {
    this.requirePermission(ctx, 'admin.reference.manage');
    if (id) {
      return this.prisma.escalationRule.update({ where: { id }, data });
    }
    return this.prisma.escalationRule.create({
      data: {
        caseTypeId: data.caseTypeId,
        trigger: data.trigger,
        thresholdHours: data.thresholdHours,
        action: data.action,
        targetRoleId: data.targetRoleId,
      },
    });
  }

  /**
   * US-4.3 + FR-4.6 escalation sweep.
   * - Thresholds come from the configured EscalationRule rows (global and
   *   per-case-type); when none exist the classic 80% warning still applies.
   * - §10.3: progress is measured in WORKING time against the organisation's
   *   business calendar; the wall-clock ratio is also honoured so a deadline
   *   that is objectively about to pass never goes unwarned.
   * - Idempotent: each case × threshold combination fires at most once (checked
   *   via the notification ledger), independent of sweep restarts.
   */
  async sweep(ctx: UserContext) {
    const now = new Date();
    const candidates = await this.prisma.case.findMany({
      where: {
        deletedAt: null,
        slaDueAt: { not: null },
        status: { in: ['ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'QUALIFIED', 'IN_REVIEW'] },
        submittedAt: { not: null },
      },
      include: { ownerUser: true, caseType: { select: { id: true } } },
    });

    const rules = await this.prisma.escalationRule.findMany({ where: { isActive: true } });
    // Thresholds keyed by scope: '*' = global, otherwise the case type id.
    const scopedRules = new Map<string, Map<number, { action: string | null; targetRoleId: string | null }>>();
    const noActivityHours: number[] = [];
    for (const r of rules) {
      const m = /^SLA_(\d+)(?:PCT)?$/i.exec(r.trigger);
      if (!m) {
        if (/^NO_ACTIVITY$/i.test(r.trigger) && !noActivityHours.includes(r.thresholdHours ?? 72)) {
          noActivityHours.push(r.thresholdHours ?? 72);
        }
        continue;
      }
      const key = r.caseTypeId ?? '*';
      if (!scopedRules.has(key)) scopedRules.set(key, new Map());
      const map = scopedRules.get(key)!;
      const pct = Math.min(100, Math.max(1, Number(m[1])));
      if (!map.has(pct)) map.set(pct, { action: r.action, targetRoleId: r.targetRoleId });
    }
    // A case obeys its type's rules on top of the global ones; when nothing
    // is configured at all the classic 80% warning still applies.
    const thresholdsFor = (caseTypeId: string | null | undefined) => {
      const merged = new Map<number, { action: string | null; targetRoleId: string | null }>(
        scopedRules.get('*') ?? [],
      );
      for (const [pct, rule] of scopedRules.get(caseTypeId ?? '\u0000') ?? []) {
        if (!merged.has(pct)) merged.set(pct, rule);
      }
      if (merged.size === 0) merged.set(80, { action: null, targetRoleId: null });
      return [...merged.entries()].sort((a, b) => a[0] - b[0]);
    };

    // Per-organisation calendar cache (settings.calendar overrides the default).
    const calendars = new Map<string, Partial<BusinessCalendar>>();
    const calendarFor = async (orgId: string): Promise<Partial<BusinessCalendar>> => {
      if (!calendars.has(orgId)) {
        const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { settings: true } });
        calendars.set(orgId, ((org?.settings as any)?.calendar as Partial<BusinessCalendar>) ?? {});
      }
      return calendars.get(orgId)!;
    };

    /** A threshold fires at most once per case — the notification ledger is
     *  the durable marker, so restarts and duplicate sweeps stay quiet. */
    const alreadyFired = async (caseId: string, eventKey: string, thresholdLabel: string) => {
      const rows = await this.prisma.notification.findMany({
        where: { templateCode: eventKey, resourceId: caseId },
        select: { payload: true },
        take: 200,
      });
      return rows.some((n) => (n.payload as any)?.variables?.threshold === thresholdLabel);
    };

    const fired: string[] = [];
    const escalated: string[] = [];

    for (const c of candidates) {
      if (c.slaPausedAt) continue; // paused: thresholds do not fire

      const cal = await calendarFor(c.organizationId);
      const pausedMs = Number(c.slaPausedMs);
      const workingTotal = Math.max(1, workingMsBetween(c.submittedAt!, c.slaDueAt!, cal) - pausedMs);
      const workingElapsed = Math.max(0, workingMsBetween(c.submittedAt!, now, cal) - pausedMs);
      const wallTotal = c.slaDueAt!.getTime() - c.submittedAt!.getTime() - pausedMs;
      const wallElapsed = now.getTime() - c.submittedAt!.getTime() - pausedMs;
      const workingRatio = workingElapsed / workingTotal;
      const wallRatio = wallTotal > 0 ? wallElapsed / wallTotal : 1;

      // ---- breach path: the real due instant has passed ----
      if (c.slaDueAt! < now) {
        if (c.status !== 'ESCALATED') {
          await this.prisma.$transaction([
            this.prisma.case.update({
              where: { id: c.id },
              data: {
                status: 'ESCALATED',
                priority: c.priority === 'LOW' ? 'NORMAL' : c.priority === 'NORMAL' ? 'HIGH' : 'CRITICAL',
                escalationFiredAt: now,
              },
            }),
            this.prisma.caseStatusHistory.create({
              data: { caseId: c.id, fromStatus: c.status, toStatus: 'ESCALATED', reason: 'SLA breach', actorId: ctx.id },
            }),
          ]);
          escalated.push(c.reference);
          fired.push(c.id);
          if (c.ownerUserId) {
            await this.notifications.notify({
              recipientId: c.ownerUserId,
              organizationId: c.organizationId,
              eventKey: 'CASE_ESCALATED',
              urgent: true,
              variables: { reference: c.reference },
              resourceType: 'case',
              resourceId: c.id,
            });
          }
        }
        continue;
      }

      // ---- configured warning thresholds (working-time, wall-clock union) ----
      for (const [pct, rule] of thresholdsFor(c.caseType?.id)) {
        const hit = workingRatio >= pct / 100 || wallRatio >= pct / 100;
        if (!hit) break;
        const eventKey = pct === 80 ? 'CASE_AT_RISK_80' : `CASE_AT_RISK_${pct}`;
        if (await alreadyFired(c.id, eventKey, String(pct))) continue;

        const action = rule.action ?? 'NOTIFY_OWNER_AND_MANAGER';
        const managerIds = (
          await this.prisma.membership.findMany({
            where: { organizationId: c.organizationId, role: { code: 'Manager' }, user: { status: 'ACTIVE' }, deletedAt: null },
            select: { userId: true },
          })
        ).map((r) => r.userId);

        const recipients = new Set<string>();
        if (action.startsWith('REASSIGN') && rule.targetRoleId) {
          const candidate = await this.prisma.membership.findFirst({
            where: { organizationId: c.organizationId, roleId: rule.targetRoleId, user: { status: 'ACTIVE' }, deletedAt: null },
            select: { userId: true },
            orderBy: { createdAt: 'asc' },
          });
          if (candidate && candidate.userId !== c.ownerUserId) {
            recipients.add(candidate.userId);
            if (c.ownerUserId) recipients.add(c.ownerUserId);
            await this.prisma.case.update({ where: { id: c.id }, data: { ownerUserId: candidate.userId } });
          }
        }
        if (recipients.size === 0) {
          if (c.ownerUserId) recipients.add(c.ownerUserId);
          for (const m of managerIds) recipients.add(m);
        }

        for (const recipientId of recipients) {
          await this.notifications.notify({
            recipientId,
            organizationId: c.organizationId,
            eventKey,
            urgent: false,
            variables: { reference: c.reference, threshold: String(pct), action },
            resourceType: 'case',
            resourceId: c.id,
          });
        }
        await this.prisma.case.update({ where: { id: c.id }, data: { escalationFiredAt: now } });
        fired.push(c.id);
      }

      // ---- inactivity rule (FR-4.6): untouched case for N hours ----
      for (const hours of noActivityHours) {
        const staleMs = now.getTime() - c.updatedAt.getTime();
        if (staleMs < hours * 3600 * 1000) continue;
        if (await alreadyFired(c.id, 'CASE_NO_ACTIVITY', String(hours))) continue;
        if (c.ownerUserId) {
          await this.notifications.notify({
            recipientId: c.ownerUserId,
            organizationId: c.organizationId,
            eventKey: 'CASE_NO_ACTIVITY',
            urgent: false,
            variables: { reference: c.reference, threshold: String(hours), hoursInactive: hours },
            resourceType: 'case',
            resourceId: c.id,
          });
        }
        fired.push(c.id);
      }
    }
    return { sweptAt: now.toISOString(), notified: fired.length, notifiedCases: fired, escalatedReferences: escalated };
  }

  /**
   * FR-4.7: reminder sweep — notifies a task's assignee before the due date.
   * Thresholds (hours before due) default to [24, 1] and are configurable per
   * organisation via Organization.settings.taskReminderHours. Idempotent: each
   * task × threshold combination fires at most once, ever.
   */
  async runReminders(ctx: UserContext) {
    this.requirePermission(ctx, 'task.read');
    const org = await this.prisma.organization.findUnique({
      where: { id: ctx.organizationId! },
      select: { settings: true },
    });
    const configured = (org?.settings as any)?.taskReminderHours;
    const thresholds: number[] =
      Array.isArray(configured) &&
      configured.length > 0 &&
      configured.every((n: any) => typeof n === 'number')
        ? configured
        : [24, 1];

    const now = Date.now();
    const tasks = await this.prisma.task.findMany({
      where: {
        organizationId: ctx.organizationId!,
        status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] },
        dueAt: { not: null },
        assigneeUserId: { not: null },
      },
      include: { case: { select: { reference: true } } },
    });

    const sent: Array<{ taskId: string; hoursBefore: number }> = [];
    for (const task of tasks) {
      const dueAtMs = task.dueAt!.getTime();
      if (dueAtMs <= now) continue; // already overdue — the escalation sweep owns that path
      for (const hours of thresholds) {
        if (dueAtMs - now > hours * 3600 * 1000) continue;
        const existing = await this.prisma.notification.findFirst({
          where: {
            recipientId: task.assigneeUserId!,
            templateCode: 'TASK_DUE_REMINDER',
            resourceId: task.id,
            payload: { path: ['thresholdHours'], equals: hours },
          },
        });
        if (existing) continue;
        await this.notifications.notify({
          recipientId: task.assigneeUserId!,
          organizationId: task.organizationId,
          eventKey: 'TASK_DUE_REMINDER',
          urgent: hours <= 1,
          resourceType: 'task',
          resourceId: task.id,
          variables: {
            taskTitle: task.title,
            caseRef: task.case?.reference ?? 'general',
            dueAt: task.dueAt!.toISOString().slice(0, 16).replace('T', ' '),
            hoursLeft: String(hours),
          },
          payloadExtras: { thresholdHours: hours },
        });
        sent.push({ taskId: task.id, hoursBefore: hours });
      }
    }
    return { sweptAt: new Date(now).toISOString(), thresholds, checked: tasks.length, remindersSent: sent };
  }
}
