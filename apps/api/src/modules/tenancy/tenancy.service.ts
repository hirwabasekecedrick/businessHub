import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { UserContext } from '../../common/abilities/case-ability.service';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../../common/audit.service';
import { NotificationService } from '../../common/notification.service';
import { MailerService } from '../../common/mailer.service';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';

@Injectable()
export class TenancyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly mailer: MailerService,
  ) {}

  private pepper() {
    return process.env.PASSWORD_PEPPER || '';
  }

  requirePermission(ctx: UserContext, permission: string) {
    if (!ctx.permissions?.includes(permission) && !ctx.permissions?.includes('*')) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', required: permission });
    }
  }

  /* A held permission satisfies a required one when they match, or when the
     holder carries a broader scope of the same action — org-wide access
     implies own-scope access, so Admin/Manager can grant Client/Visitor
     roles without holding the literal `*.own` grants. */
  private permissionSatisfied(held: Set<string>, needed: string): boolean {
    if (held.has(needed)) return true;
    if (!needed.endsWith('.own')) return false;
    const base = needed.slice(0, -'.own'.length);
    return held.has(`${base}.org`) || held.has(base);
  }

  // ---------- ORGANIZATIONS ----------

  async getOrganizations(ctx: UserContext) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId: ctx.id, deletedAt: null },
      include: { organization: true, role: true },
    });
    return memberships.map((m) => ({
      id: m.organization.id,
      legalName: m.organization.legalName,
      tradingName: m.organization.tradingName,
      type: m.organization.type,
      status: m.organization.status,
      roleCode: m.role.code,
      permissions: m.role.permissions,
      isDefault: m.isDefault,
    }));
  }

  async createOrganization(ctx: UserContext, data: any) {
    this.requirePermission(ctx, 'org.create');
    return this.prisma.organization.create({
      data: {
        type: data.type ?? 'CLIENT',
        legalName: data.legalName,
        tradingName: data.tradingName,
        registrationNo: data.registrationNo,
        taxId: data.taxId,
        country: data.country ?? 'RW',
        status: 'ACTIVE',
        settings: data.settings ?? {},
      },
    });
  }

  async getOrganization(ctx: UserContext, id: string) {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org || org.deletedAt) throw new NotFoundException({ code: 'ORG_NOT_FOUND' });

    const isMember = await this.prisma.membership.findFirst({
      where: { userId: ctx.id, organizationId: id, deletedAt: null },
    });
    const canReadAll = ctx.permissions.includes('case.read.all') || ctx.permissions.includes('*');
    if (!isMember && !canReadAll) throw new ForbiddenException({ code: 'ORG_FORBIDDEN' });

    const memberCount = await this.prisma.membership.count({ where: { organizationId: id, deletedAt: null } });
    return { ...org, memberCount };
  }

  async updateOrganization(ctx: UserContext, id: string, data: any) {
    this.requirePermission(ctx, 'org.update');
    const membership = await this.prisma.membership.findFirst({
      where: { userId: ctx.id, organizationId: id, deletedAt: null },
    });
    if (!membership && !ctx.permissions.includes('*')) throw new ForbiddenException({ code: 'ORG_FORBIDDEN' });

    const before = await this.prisma.organization.findUnique({ where: { id } });
    if (!before || before.deletedAt) throw new NotFoundException({ code: 'ORG_NOT_FOUND' });

    const updated = await this.prisma.organization.update({
      where: { id },
      data: {
        legalName: data.legalName,
        tradingName: data.tradingName,
        registrationNo: data.registrationNo,
        taxId: data.taxId,
        address: data.address,
        settings: data.settings ?? undefined,
      },
    });
    await this.audit.record({ actorUserId: ctx.id, organizationId: id, action: 'ORG_UPDATED', resourceType: 'organization', resourceId: id, before, after: updated });
    return updated;
  }

  async suspendOrganization(ctx: UserContext, id: string, reason: string) {
    this.requirePermission(ctx, 'org.suspend');
    const updated = await this.prisma.organization.update({
      where: { id },
      data: { status: 'SUSPENDED', settings: { reason } },
    });
    await this.audit.record({ actorUserId: ctx.id, organizationId: id, action: 'ORG_SUSPENDED', resourceType: 'organization', resourceId: id, after: { reason } });
    return updated;
  }

  async reactivateOrganization(ctx: UserContext, id: string) {
    this.requirePermission(ctx, 'org.suspend');
    const updated = await this.prisma.organization.update({ where: { id }, data: { status: 'ACTIVE' } });
    await this.audit.record({ actorUserId: ctx.id, organizationId: id, action: 'ORG_REACTIVATED', resourceType: 'organization', resourceId: id });
    return updated;
  }

  async getMembers(ctx: UserContext, orgId: string) {
    const isMember = await this.prisma.membership.findFirst({
      where: { userId: ctx.id, organizationId: orgId, deletedAt: null },
    });
    if (!isMember && !ctx.permissions.includes('*')) throw new ForbiddenException({ code: 'ORG_FORBIDDEN' });

    const members = await this.prisma.membership.findMany({
      where: { organizationId: orgId, deletedAt: null },
      include: { user: true, role: true },
    });
    return members.map((m) => ({
      membershipId: m.id,
      userId: m.user.id,
      email: m.user.email,
      firstName: m.user.firstName,
      lastName: m.user.lastName,
      status: m.user.status,
      roleId: m.role.id,
      roleCode: m.role.code,
      roleName: m.role.name,
      approvalLevel: m.role.approvalLevel,
      isDefault: m.isDefault,
      joinedAt: m.acceptedAt,
    }));
  }

  /* One-time tokens are echoed in API responses ONLY for local testing and
   * the acceptance suite. Production must leave EXPOSE_DEV_TOKENS unset. */
  private devTokensOn(): boolean {
    return process.env.NODE_ENV !== 'production' && process.env.EXPOSE_DEV_TOKENS === '1';
  }

  async inviteUser(ctx: UserContext, orgId: string, email: string, roleId: string) {
    this.requirePermission(ctx, 'user.invite');

    const myMembership = await this.prisma.membership.findFirst({
      where: { userId: ctx.id, organizationId: orgId, deletedAt: null },
      include: { role: true },
    });
    const targetRole = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!targetRole) throw new NotFoundException({ code: 'ROLE_NOT_FOUND' });

    // Cannot assign a role with more permissions than your own (US-1.4).
    const myPerms = new Set(myMembership ? [...myMembership.role.permissions] : ctx.permissions);
    if (myMembership && !myPerms.has('*')) {
      for (const p of targetRole.permissions) {
        if (!this.permissionSatisfied(myPerms, p)) {
          await this.audit.record({
            actorUserId: ctx.id,
            organizationId: orgId,
            action: 'INVITATION_DENIED_ROLE_ESCALATION',
            resourceType: 'role',
            resourceId: roleId,
            outcome: 'DENIED',
          });
          throw new ForbiddenException({
            code: 'ROLE_ESCALATION_FORBIDDEN',
            missingPermission: p,
          });
        }
      }
    }
    if (myMembership && !myPerms.has('*') && targetRole.approvalLevel > myMembership.role.approvalLevel) {
      throw new ForbiddenException({ code: 'ROLE_ESCALATION_FORBIDDEN' });
    }

    // FR-1.3: Manager/Admin/Super cannot be assigned to a user who has not
    // enrolled in MFA.
    const MFA_MANDATORY = ['Manager', 'Admin', 'Super'];
    if (MFA_MANDATORY.includes(targetRole.code)) {
      const existing = await this.prisma.user.findUnique({
        where: { email: email.toLowerCase() },
        select: { mfaSecret: true, mfaEnabledAt: true },
      });
      if (!existing || !existing.mfaSecret || !existing.mfaEnabledAt) {
        throw new UnprocessableEntityException({ code: 'MFA_ENROLMENT_REQUIRED_FOR_ROLE' });
      }
    }

    const token = crypto.randomBytes(24).toString('hex');
    const invitation = await this.prisma.invitation.create({
      data: {
        organizationId: orgId,
        email: email.toLowerCase(),
        roleId,
        token,
        invitedById: ctx.id,
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days
      },
    });

    // In-app notification for the inviting user (audit trail of the invite).
    await this.notifications.notify({
      recipientId: ctx.id,
      organizationId: orgId,
      eventKey: 'USER_INVITED',
      variables: { email, invitedBy: ctx.email },
    });

    // Real invitation email to the invitee.
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { legalName: true },
    });
    await this.sendInvitationEmail(
      email,
      org?.legalName ?? 'an organization',
      targetRole.name,
      token,
    );

    const devMode = this.devTokensOn();
    return {
      invitationId: invitation.id,
      expiresAt: invitation.expiresAt,
      message: 'Invitation created and email sent',
      ...(devMode ? { devAcceptToken: token } : {}),
    };
  }

  private async sendInvitationEmail(to: string, orgName: string, roleName: string, token: string) {
    const frontend = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    await this.mailer.send({
      to,
      subject: `You have been invited to join ${orgName} on BusinessHub`,
      text: `You have been invited to join ${orgName} as ${roleName}.\n\nAccept with this invitation code in BusinessHub:\n${token}\n\nThe invitation expires in 14 days.`,
      html: this.mailer.wrap(
        `Join ${orgName}`,
        `<p>You have been invited to join <strong>${this.escape(orgName)}</strong> on BusinessHub as <strong>${this.escape(roleName)}</strong>.</p><p>Use this invitation code when accepting:</p><p style="font-family:monospace;background:#f1f5f9;padding:10px 14px;border-radius:6px">${this.escape(token)}</p>`,
        'Open BusinessHub',
        frontend,
      ),
    });
  }

  private escape(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
  }

  async acceptInvitation(token: string, password?: string) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { token },
      include: { organization: true, role: true },
    });
    if (!invitation || invitation.status !== 'PENDING' || invitation.expiresAt < new Date()) {
      throw new UnprocessableEntityException({ code: 'INVITATION_INVALID_OR_EXPIRED' });
    }

    let user = await this.prisma.user.findUnique({ where: { email: invitation.email } });
    if (!user) {
      if (!password || password.length < 12) {
        throw new UnprocessableEntityException({
          code: 'VALIDATION_FAILED',
          rule: 'password_min_length_12',
          message: 'New users must provide a password of at least 12 characters',
        });
      }
      const passwordHash = await argon2.hash(password + this.pepper(), {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
      });
      user = await this.prisma.user.create({
        data: {
          email: invitation.email,
          passwordHash,
          firstName: 'Invited',
          lastName: 'User',
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
        },
      });
    }

    const existing = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId: invitation.organizationId } },
    });
    if (existing && !existing.deletedAt) {
      throw new ConflictException({ code: 'ALREADY_MEMBER' });
    }

    const membership =
      existing && existing.deletedAt
        ? await this.prisma.membership.update({ where: { id: existing.id }, data: { deletedAt: null, roleId: invitation.roleId, acceptedAt: new Date() } })
        : await this.prisma.membership.create({
            data: {
              userId: user.id,
              organizationId: invitation.organizationId,
              roleId: invitation.roleId,
              acceptedAt: new Date(),
              invitedById: invitation.invitedById,
            },
          });

    await this.prisma.invitation.update({ where: { id: invitation.id }, data: { status: 'ACCEPTED' } });
    await this.audit.record({
      actorUserId: user.id,
      organizationId: invitation.organizationId,
      action: 'INVITATION_ACCEPTED',
      resourceType: 'membership',
      resourceId: membership.id,
    });

    return {
      message: `Welcome to ${invitation.organization.legalName}`,
      userId: user.id,
      organizationId: invitation.organization.id,
      roleCode: invitation.role.code,
    };
  }

  async resendInvitation(ctx: UserContext, invitationId: string) {
    this.requirePermission(ctx, 'user.invite');
    const invitation = await this.prisma.invitation.findUnique({
      where: { id: invitationId },
      include: { organization: true, role: true },
    });
    if (!invitation) throw new NotFoundException({ code: 'INVITATION_NOT_FOUND' });
    const token = crypto.randomBytes(24).toString('hex');
    const updated = await this.prisma.invitation.update({
      where: { id: invitationId },
      data: { token, status: 'PENDING', expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) },
    });
    await this.sendInvitationEmail(
      invitation.email,
      invitation.organization.legalName,
      invitation.role.name,
      token,
    );
    const devMode = this.devTokensOn();
    return { message: 'Invitation resent', ...(devMode ? { devAcceptToken: token } : {}), expiresAt: updated.expiresAt };
  }

  async revokeInvitation(ctx: UserContext, token: string) {
    this.requirePermission(ctx, 'user.invite');
    // The route parameter is the invitation token (same one used to accept).
    const invitation = await this.prisma.invitation.findUnique({ where: { token } });
    if (!invitation) throw new NotFoundException({ code: 'INVITATION_NOT_FOUND' });
    await this.prisma.invitation.update({ where: { id: invitation.id }, data: { status: 'REVOKED' } });
    await this.audit.record({
      actorUserId: ctx.id,
      organizationId: invitation.organizationId,
      action: 'INVITATION_REVOKED',
      resourceType: 'invitation',
      resourceId: invitation.id,
    });
    return { message: 'Invitation revoked' };
  }

  // ---------- MEMBERSHIPS ----------

  async removeMember(ctx: UserContext, membershipId: string) {
    this.requirePermission(ctx, 'role.assign');
    const membership = await this.prisma.membership.findUnique({ where: { id: membershipId } });
    if (!membership || membership.deletedAt) throw new NotFoundException({ code: 'MEMBERSHIP_NOT_FOUND' });
    await this.prisma.membership.update({ where: { id: membershipId }, data: { deletedAt: new Date() } });
    await this.prisma.session.updateMany({ where: { userId: membership.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record({
      actorUserId: ctx.id,
      organizationId: membership.organizationId,
      action: 'MEMBER_REMOVED',
      resourceType: 'membership',
      resourceId: membershipId,
    });
    return { message: 'Member removed' };
  }

  async changeRole(ctx: UserContext, membershipId: string, roleId: string) {
    this.requirePermission(ctx, 'role.assign');
    const membership = await this.prisma.membership.findUnique({ where: { id: membershipId } });
    if (!membership || membership.deletedAt) throw new NotFoundException({ code: 'MEMBERSHIP_NOT_FOUND' });

    const myMembership = await this.prisma.membership.findFirst({
      where: { userId: ctx.id, organizationId: membership.organizationId, deletedAt: null },
      include: { role: true },
    });
    const targetRole = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!targetRole) throw new NotFoundException({ code: 'ROLE_NOT_FOUND' });

    if (myMembership && !myMembership.role.permissions.includes('*')) {
      const myPerms = new Set(myMembership.role.permissions);
      for (const p of targetRole.permissions) {
        if (!this.permissionSatisfied(myPerms, p)) throw new ForbiddenException({ code: 'ROLE_ESCALATION_FORBIDDEN', missingPermission: p });
      }
    }

    const updated = await this.prisma.membership.update({ where: { id: membershipId }, data: { roleId } });
    await this.audit.record({
      actorUserId: ctx.id,
      organizationId: membership.organizationId,
      action: 'ROLE_CHANGED',
      resourceType: 'membership',
      resourceId: membershipId,
      before: { roleId: membership.roleId },
      after: { roleId },
    });
    return updated;
  }

  // ---------- USERS ----------

  async getUsers(ctx: UserContext) {
    this.requirePermission(ctx, 'user.read');
    const memberships = await this.prisma.membership.findMany({
      where: { organizationId: ctx.organizationId, deletedAt: null },
      include: { user: true, role: true },
    });
    return memberships.map((m) => ({
      id: m.user.id,
      email: m.user.email,
      firstName: m.user.firstName,
      lastName: m.user.lastName,
      status: m.user.status,
      roleCode: m.role.code,
      membershipId: m.id,
    }));
  }

  async getUser(ctx: UserContext, id: string) {
    this.requirePermission(ctx, 'user.read');
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { memberships: { include: { role: true, organization: true }, where: { deletedAt: null } } },
    });
    if (!user || user.deletedAt) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
    return user;
  }

  async updateUser(ctx: UserContext, id: string, data: any) {
    this.requirePermission(ctx, 'user.update');
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.deletedAt) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        phone: data.phone,
        locale: data.locale,
        timezone: data.timezone,
      },
    });
    await this.audit.record({ actorUserId: ctx.id, action: 'USER_UPDATED', resourceType: 'user', resourceId: id, after: { firstName: data.firstName, lastName: data.lastName } });
    return updated;
  }

  /** US-1.5 / FR-1.7: deactivate revokes sessions immediately and returns open tasks to the queue. */
  async deactivateUser(ctx: UserContext, id: string) {
    this.requirePermission(ctx, 'user.deactivate');
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.deletedAt) throw new NotFoundException({ code: 'USER_NOT_FOUND' });

    const openTasks = await this.prisma.task.findMany({
      where: { assigneeUserId: id, status: { in: ['OPEN', 'IN_PROGRESS', 'BLOCKED'] } },
      include: { case: true },
    });

    // Capture the orgs while memberships are still live; managers there get the handover notice.
    const orgIds = [
      ...new Set(
        (
          await this.prisma.membership.findMany({
            where: { userId: id, deletedAt: null },
            select: { organizationId: true },
          })
        ).map((m) => m.organizationId),
      ),
    ];

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { status: 'DISABLED', deletedAt: new Date() } });
      await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.membership.updateMany({ where: { userId: id, deletedAt: null }, data: { deletedAt: new Date() } });
      // Open tasks return to the role queue.
      for (const task of openTasks) {
        await tx.task.update({
          where: { id: task.id },
          data: { assigneeUserId: null, assigneeRoleId: task.assigneeRoleId ?? undefined },
        });
      }
      return openTasks.length;
    });

    await this.audit.record({
      actorUserId: ctx.id,
      action: 'USER_DEACTIVATED',
      resourceType: 'user',
      resourceId: id,
      after: { returnedTasksToQueue: result },
    });

    // US-1.5: every manager/admin of each affected org is notified with the returned task list.
    const taskList = openTasks.map((t) => t.title).slice(0, 8).join(', ');
    for (const orgId of orgIds) {
      const managers = await this.prisma.membership.findMany({
        where: {
          organizationId: orgId,
          deletedAt: null,
          userId: { not: id },
          role: { code: { in: ['Manager', 'Admin', 'Super'] } },
        },
        select: { userId: true },
      });
      for (const manager of [...new Map(managers.map((m) => [m.userId, m])).values()]) {
        await this.notifications.notify({
          recipientId: manager.userId,
          organizationId: orgId,
          eventKey: 'USER_DEACTIVATED',
          urgent: true,
          resourceType: 'user',
          resourceId: id,
          variables: {
            user: user.email,
            tasksReturned: result,
            taskList: taskList || 'none',
            deactivatedBy: ctx.email,
          },
        });
      }
    }
    return {
      message: 'User deactivated; sessions revoked; tasks returned to queue',
      sessionsRevoked: true,
      tasksReturnedToQueue: result,
    };
  }

  // ---------- ROLES ----------

  async getRoles(ctx: UserContext) {
    this.requirePermission(ctx, 'role.read');
    const roles = await this.prisma.role.findMany({
      where: { OR: [{ organizationId: ctx.organizationId }, { organizationId: null }] },
      orderBy: { createdAt: 'asc' },
    });
    return roles;
  }

  async createRole(ctx: UserContext, data: any) {
    this.requirePermission(ctx, 'role.manage');
    // Custom roles may only use codes from the catalogue and no more than the creator holds.
    const myPerms = new Set(ctx.permissions);
    if (!myPerms.has('*')) {
      for (const p of data.permissions ?? []) {
        if (!myPerms.has(p)) throw new ForbiddenException({ code: 'PERMISSION_DENIED', required: p });
      }
    }
    return this.prisma.role.create({
      data: {
        organizationId: ctx.organizationId,
        code: data.code,
        name: data.name,
        permissions: data.permissions ?? [],
        approvalLevel: data.approvalLevel ?? 0,
        isSystem: false,
      },
    });
  }

  async updateRole(ctx: UserContext, id: string, data: any) {
    this.requirePermission(ctx, 'role.manage');
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException({ code: 'ROLE_NOT_FOUND' });
    if (role.isSystem) throw new ForbiddenException({ code: 'SYSTEM_ROLE_IMMUTABLE' });
    const updated = await this.prisma.role.update({
      where: { id },
      data: {
        name: data.name,
        permissions: data.permissions,
        approvalLevel: data.approvalLevel,
      },
    });
    await this.audit.record({
      actorUserId: ctx.id,
      organizationId: role.organizationId,
      action: 'ROLE_UPDATED',
      resourceType: 'role',
      resourceId: id,
      before: { permissions: role.permissions },
      after: { permissions: data.permissions },
    });
    return updated;
  }
}
