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
   * US-4.3: escalation sweep. Idempotent — escalationFiredAt guarantees a single
   * notification per case even if the sweep runs twice in the same minute.
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
      include: { ownerUser: true },
    });

    const fired: string[] = [];
    const escalated: string[] = [];
    for (const c of candidates) {
      if (c.slaPausedAt) continue; // paused: thresholds do not fire
      const totalMs = c.slaDueAt!.getTime() - c.submittedAt!.getTime() - Number(c.slaPausedMs);
      const elapsedMs = now.getTime() - c.submittedAt!.getTime() - Number(c.slaPausedMs);
      const ratio = totalMs > 0 ? elapsedMs / totalMs : 1;

      if (ratio >= 1) {
        if (c.slaDueAt! >= now) continue;
        // Breached: transition to ESCALATED once, priority raised one step.
        // escalationFiredAt only gates the earlier 80% warning — a breached
        // case must still escalate even if it was warned.
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
      } else if (ratio >= 0.8 && !c.escalationFiredAt) {
        // 80% threshold: warn owner and manager once, never repeatedly.
        if (c.ownerUserId) {
          await this.notifications.notify({
            recipientId: c.ownerUserId,
            organizationId: c.organizationId,
            eventKey: 'CASE_AT_RISK_80',
            urgent: false,
            variables: { reference: c.reference },
            resourceType: 'case',
            resourceId: c.id,
          });
        }
        await this.prisma.case.update({ where: { id: c.id }, data: { escalationFiredAt: now } });
        fired.push(c.id);
      }
    }
    return { sweptAt: now.toISOString(), notified: fired.length, notifiedCases: fired, escalatedReferences: escalated };
  }
}
