import {
  UnprocessableEntityException,
  Controller,
  Put,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../../common/audit.service';
import { NotificationService } from '../../common/notification.service';
import { JwtService } from '@nestjs/jwt';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { UserContext } from '../../common/abilities/case-ability.service';

@Controller('v1')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly jwt: JwtService,
  ) {}

  requirePermission(ctx: UserContext, permission: string) {
    if (!ctx.permissions?.includes(permission) && !ctx.permissions?.includes('*')) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', required: permission });
    }
  }

  // ---------- AUDIT (US-9.1) ----------

  @Get('admin/audit')
  async searchAudit(
    @CurrentUser() ctx: UserContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('actor') actor?: string,
    @Query('action') action?: string,
    @Query('resourceType') resourceType?: string,
  ) {
    this.requirePermission(ctx, 'admin.audit.read');
    return this.prisma.auditEvent.findMany({
      where: {
        ...(from || to
          ? { occurredAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } }
          : {}),
        ...(actor ? { actorUserId: actor } : {}),
        ...(action ? { action: { contains: action } } : {}),
        ...(resourceType ? { resourceType } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: 500,
    });
  }

  /**
   * FR-9.5: proves the audit trail is append-only at the database level.
   * Attempts an UPDATE and a DELETE against the newest audit row — both must be
   * rejected by the audit_event_append_only trigger regardless of role grants.
   */
  @Post('admin/audit/append-only-check')
  @HttpCode(200)
  async appendOnlyCheck(@CurrentUser() ctx: UserContext) {
    this.requirePermission(ctx, 'admin.audit.read');
    const newest = await this.prisma.auditEvent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
    if (!newest) return { enforced: true, reason: 'NO_ROWS' };
    const results: Record<string, boolean> = {};
    for (const op of ['update', 'delete'] as const) {
      try {
        if (op === 'update') {
          await this.prisma.auditEvent.update({
            where: { id: newest.id },
            data: { outcome: 'TAMPERED' },
          });
        } else {
          await this.prisma.auditEvent.delete({ where: { id: newest.id } });
        }
        results[op] = false; // mutation went through — enforcement is broken
      } catch {
        results[op] = true; // rejected by the database
      }
    }
    const stillThere = await this.prisma.auditEvent.findUnique({ where: { id: newest.id }, select: { id: true, outcome: true } });
    await this.audit.record({
      actorUserId: ctx.id,
      action: 'AUDIT_APPEND_ONLY_CHECK',
      resourceType: 'audit_event',
      resourceId: String(newest.id),
      after: results,
    });
    return {
      enforced: results.update && results.delete && stillThere?.outcome !== 'TAMPERED',
      operations: results,
    };
  }

  /** US-9.1: export runs as a Job; result carries the CSV payload. */  @Post('admin/audit/export')
  async exportAudit(@CurrentUser() ctx: UserContext, @Body() body: any) {
    this.requirePermission(ctx, 'admin.audit.read');
    const events = await this.prisma.auditEvent.findMany({
      where: {
        occurredAt: {
          gte: body.from ? new Date(body.from) : new Date(Date.now() - 30 * 24 * 3600 * 1000),
          lte: body.to ? new Date(body.to) : new Date(),
        },
      },
      orderBy: { occurredAt: 'asc' },
    });
    const csv = [
      'occurred_at,actor,effective_user,action,resource_type,resource_id,outcome',
      ...events.map((e) =>
        [e.occurredAt.toISOString(), e.actorUserId, e.effectiveUserId ?? '', e.action, e.resourceType ?? '', e.resourceId ?? '', e.outcome].join(','),
      ),
    ].join('\n');
    const job = await this.prisma.job.create({
      data: {
        organizationId: ctx.organizationId,
        type: 'AUDIT_EXPORT',
        status: 'DONE',
        completedAt: new Date(),
        createdBy: ctx.id,
        params: body,
        result: { rows: events.length },
      },
    });
    await this.audit.record({
      actorUserId: ctx.id,
      action: 'AUDIT_EXPORTED',
      resourceType: 'job',
      resourceId: job.id,
      after: { rows: events.length },
    });
    return { jobId: job.id, csv };
  }

  // ---------- IMPERSONATION (read-only enforcement lives in services) ----------

  /** Super admin acts as another user; every action is flagged and audited. */
  @Post('admin/impersonate')
  async impersonate(@CurrentUser() ctx: UserContext, @Body() body: any) {
    this.requirePermission(ctx, 'admin.impersonate');
    if (ctx.isImpersonating) throw new ForbiddenException({ code: 'IMPERSONATION_FORBIDDEN' });

    const target = body.email
      ? await this.prisma.user.findUnique({ where: { email: String(body.email).toLowerCase() } })
      : await this.prisma.user.findUnique({ where: { id: body.userId } });
    if (!target || target.status === 'DISABLED') throw new NotFoundException({ code: 'USER_NOT_FOUND' });

    const token = await this.jwt.signAsync({
      sub: target.id,
      act: ctx.id,
      imp: true,
      typ: 'access',
    });
    await this.audit.record({
      actorUserId: ctx.id,
      effectiveUserId: target.id,
      organizationId: ctx.organizationId,
      action: 'IMPERSONATION_STARTED',
      resourceType: 'user',
      resourceId: target.id,
      outcome: 'SUCCESS',
    });
    return {
      impersonationToken: token,
      actingAs: { id: target.id, email: target.email },
      note: 'Token is read-only; mutating endpoints reject impersonated sessions.',
    };
  }

  @Post('admin/impersonate/stop')
  @HttpCode(200)
  async stopImpersonation(@CurrentUser() ctx: UserContext) {
    const actorId = (ctx as any).actorUserId;
    await this.audit.record({
      actorUserId: actorId ?? ctx.id,
      effectiveUserId: ctx.id,
      organizationId: ctx.organizationId,
      action: 'IMPERSONATION_STOPPED',
      resourceType: 'user',
      resourceId: ctx.id,
      outcome: 'SUCCESS',
    });
    return { message: 'Impersonation session ended' };
  }

  // ---------- INTEGRATIONS (US-9.3) ----------

  @Get('integrations')
  async listIntegrations() {
    return this.prisma.integrationConfig.findMany();
  }

  @Put('integrations/:code')
  async upsertIntegration(@CurrentUser() ctx: UserContext, @Param('code') code: string, @Body() body: any) {
    this.requirePermission(ctx, 'admin.integration.manage');
    const masked = JSON.parse(JSON.stringify(body.config ?? {}));
    for (const key of Object.keys(masked)) {
      if (/secret|key|token|password/i.test(key)) masked[key] = '********';
    }
    return this.prisma.integrationConfig.upsert({
      where: { code },
      update: { displayName: body.displayName, config: masked, isActive: body.isActive ?? true },
      create: {
        code,
        displayName: body.displayName ?? code,
        config: masked,
        isActive: body.isActive ?? false,
      },
    });
  }

  /**
   * Connectivity test against the mocked provider — records lastTestAt/result.
   */
  @Post('integrations/:code/test')
  @HttpCode(200)
  async testIntegration(@CurrentUser() ctx: UserContext, @Param('code') code: string) {
    this.requirePermission(ctx, 'admin.integration.manage');
    const cfg = await this.prisma.integrationConfig.findUnique({ where: { code } });
    if (!cfg) throw new NotFoundException({ code: 'INTEGRATION_NOT_FOUND' });
    const result = { ok: true, testedAt: new Date().toISOString(), provider: cfg.code, mode: 'mock' };
    await this.prisma.integrationConfig.update({
      where: { code },
      data: { lastTestAt: new Date(), lastTestResult: result },
    });
    await this.audit.record({
      actorUserId: ctx.id,
      organizationId: ctx.organizationId,
      action: 'INTEGRATION_TESTED',
      resourceType: 'integration_config',
      resourceId: cfg.id,
      outcome: 'SUCCESS',
    });
    return result;
  }

  // ---------- ORGANISATION SETTINGS (FR-9.2) ----------

  @Get('admin/settings')
  async getSettings(@CurrentUser() ctx: UserContext) {
    this.requirePermission(ctx, 'org.settings.manage');
    const org = await this.prisma.organization.findUnique({ where: { id: ctx.organizationId! } });
    if (!org) throw new NotFoundException({ code: 'ORG_NOT_FOUND' });
    return {
      organizationId: org.id,
      settings: {
        branding: {},
        locale: 'en',
        currency: 'EUR',
        invoiceNumbering: 'INV-YYYY-NNNNN',
        dunningScheduleDays: [7, 14, 30],
        ...((org.settings as Record<string, unknown>) ?? {}),
      },
    };
  }

  @Put('admin/settings')
  async putSettings(@CurrentUser() ctx: UserContext, @Body() body: any) {
    this.requirePermission(ctx, 'org.settings.manage');
    const org = await this.prisma.organization.findUnique({ where: { id: ctx.organizationId! } });
    if (!org) throw new NotFoundException({ code: 'ORG_NOT_FOUND' });
    const merged = { ...((org.settings as Record<string, unknown>) ?? {}), ...(body ?? {}) };
    if (body?.currency && !/^[A-Z]{3}$/.test(body.currency)) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', rule: 'currency_iso_4217' });
    }
    if (body?.dunningScheduleDays && (!Array.isArray(body.dunningScheduleDays) || body.dunningScheduleDays.some((d: any) => !Number.isInteger(d) || d < 1))) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', rule: 'dunning_days' });
    }
    await this.prisma.organization.update({ where: { id: org.id }, data: { settings: merged } });
    await this.audit.record({
      actorUserId: ctx.id,
      organizationId: ctx.organizationId,
      action: 'org.settings_changed',
      resourceType: 'organization',
      resourceId: org.id,
      before: org.settings as any,
      after: merged,
    });
    return { organizationId: org.id, settings: merged };
  }

  // ---------- REFERENCE DATA (FR-9.1) ----------

  private static readonly REFERENCE_DEFAULTS: Record<string, unknown[]> = {
    'tax-rates': [{ name: 'Standard', rate: 18 }, { name: 'Zero', rate: 0 }],
    'business-calendars': [
      { name: 'Main', workingDays: [1, 2, 3, 4, 5], workStart: '08:00', workEnd: '17:00', holidays: [] },
    ],
    'document-categories': ['incorporation_certificate', 'tax_clearance', 'contract'],
    priorities: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
  };

  @Get('admin/reference/:set')
  async getReferenceSet(@CurrentUser() ctx: UserContext, @Param('set') set: string) {
    this.requirePermission(ctx, 'admin.reference.manage');
    if (!AdminController.REFERENCE_DEFAULTS[set]) {
      throw new NotFoundException({ code: 'REFERENCE_SET_NOT_FOUND', set });
    }
    const row = await this.prisma.referenceSet.findUnique({
      where: { organizationId_set: { organizationId: ctx.organizationId!, set } },
    });
    return { set, items: (row?.items as unknown[]) ?? AdminController.REFERENCE_DEFAULTS[set], customized: !!row, updatedAt: row?.updatedAt ?? null };
  }

  @Put('admin/reference/:set')
  async putReferenceSet(@CurrentUser() ctx: UserContext, @Param('set') set: string, @Body() body: any) {
    this.requirePermission(ctx, 'admin.reference.manage');
    if (!AdminController.REFERENCE_DEFAULTS[set]) {
      throw new NotFoundException({ code: 'REFERENCE_SET_NOT_FOUND', set });
    }
    if (!Array.isArray(body?.items)) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', rule: 'items_array_required' });
    }
    const saved = await this.prisma.referenceSet.upsert({
      where: { organizationId_set: { organizationId: ctx.organizationId!, set } },
      update: { items: body.items, updatedById: ctx.id },
      create: { organizationId: ctx.organizationId!, set, items: body.items, updatedById: ctx.id },
    });
    await this.audit.record({
      actorUserId: ctx.id,
      organizationId: ctx.organizationId,
      action: 'admin.reference_changed',
      resourceType: 'reference_set',
      resourceId: saved.id,
      after: { set, count: body.items.length },
    });
    return { set, items: saved.items as unknown[], updatedAt: saved.updatedAt };
  }

  // ---------- FEATURE FLAGS & MAINTENANCE MODE (FR-9.5) ----------

  private static readonly FLAG_DEFAULTS = {
    featureFlags: {
      onlinePayments: true,
      publicIntake: true,
      partnerPortal: false,
    } as Record<string, boolean>,
    maintenance: { enabled: false, message: null as string | null },
  };

  @Get('admin/flags')
  async getFlags(@CurrentUser() ctx: UserContext) {
    this.requirePermission(ctx, 'org.settings.manage');
    const org = await this.prisma.organization.findUnique({ where: { id: ctx.organizationId! } });
    const s = (org?.settings as Record<string, any>) ?? {};
    return {
      featureFlags: { ...AdminController.FLAG_DEFAULTS.featureFlags, ...(s.featureFlags ?? {}) },
      maintenance: { ...AdminController.FLAG_DEFAULTS.maintenance, ...(s.maintenance ?? {}) },
      knownFlags: Object.keys(AdminController.FLAG_DEFAULTS.featureFlags),
    };
  }

  @Put('admin/flags')
  async putFlags(@CurrentUser() ctx: UserContext, @Body() body: any) {
    this.requirePermission(ctx, 'org.settings.manage');
    const org = await this.prisma.organization.findUnique({ where: { id: ctx.organizationId! } });
    if (!org) throw new NotFoundException({ code: 'ORG_NOT_FOUND' });
    const current = ((org.settings as Record<string, any>) ?? {}) as Record<string, any>;

    let flags = current.featureFlags ?? {};
    if (body?.flags !== undefined) {
      flags = {
        ...AdminController.FLAG_DEFAULTS.featureFlags,
        ...flags,
        ...Object.fromEntries(
          Object.entries(body.flags).filter(([, v]) => typeof v === 'boolean'),
        ),
      };
    }
    let maintenance = current.maintenance ?? {};
    if (body?.maintenance !== undefined) {
      maintenance = {
        ...maintenance,
        enabled: body.maintenance.enabled === true,
        message: body.maintenance.message ? String(body.maintenance.message).slice(0, 280) : null,
      };
    }

    await this.prisma.organization.update({
      where: { id: org.id },
      data: { settings: { ...current, featureFlags: flags, maintenance } },
    });
    await this.audit.record({
      actorUserId: ctx.id,
      organizationId: ctx.organizationId,
      action: 'admin.flags_changed',
      resourceType: 'organization',
      resourceId: org.id,
      after: { flags, maintenance },
    });
    this.invalidateMaintenanceCache();
    return { featureFlags: flags, maintenance };
  }

  /** Short-TTL cache so the per-request guard check stays cheap. */
  private static maintenanceCache: { value: { enabled: boolean; message: string | null }; at: number } | null = null;
  private invalidateMaintenanceCache() {
    AdminController.maintenanceCache = null;
  }
  private async readMaintenance(): Promise<{ enabled: boolean; message: string | null }> {
    if (AdminController.maintenanceCache && Date.now() - AdminController.maintenanceCache.at < 5000) {
      return AdminController.maintenanceCache.value;
    }
    const internal = await this.prisma.organization.findFirst({
      where: { type: 'INTERNAL' },
      select: { settings: true },
    });
    const m = ((internal?.settings as Record<string, any>) ?? {}).maintenance ?? {};
    const value = { enabled: m.enabled === true, message: m.message ?? null };
    AdminController.maintenanceCache = { value, at: Date.now() };
    return value;
  }

  // ---------- NOTIFICATION TEMPLATES (US-7.4) ----------

  @Get('admin/reference/notification-templates')
  async listTemplates(@CurrentUser() ctx: UserContext) {
    this.requirePermission(ctx, 'admin.reference.manage');
    return this.prisma.notificationTemplate.findMany({ orderBy: { code: 'asc' } });
  }

  @Put('admin/reference/notification-templates/:code')
  async upsertTemplate(@CurrentUser() ctx: UserContext, @Param('code') code: string, @Body() body: any) {
    this.requirePermission(ctx, 'admin.reference.manage');
    // US-7.2: a template may never reference an undeclared {{variable}}.
    const declared: string[] = body.variables ?? [];
    const referenced = new Set<string>();
    for (const locale of Object.values(body.locales ?? {}) as Array<any>) {
      const text = `${locale?.subject ?? ''} ${locale?.body ?? ''}`;
      for (const m of text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) referenced.add(m[1]);
    }
    const unknown = [...referenced].filter((v) => !declared.includes(v));
    if (unknown.length) {
      throw new UnprocessableEntityException({ code: 'UNKNOWN_VARIABLE', variables: unknown });
    }
    return this.prisma.notificationTemplate.upsert({
      where: { code },
      update: { locales: body.locales, variables: body.variables ?? [], urgent: body.urgent ?? false },
      create: {
        code,
        eventKey: body.eventKey ?? code,
        locales: body.locales,
        variables: body.variables ?? [],
        urgent: body.urgent ?? false,
      },
    });
  }

  // ---------- HEALTH ----------

  @Public()
  @Get('health')
  async health() {
    return { status: 'ok', uptimeSec: Math.floor(process.uptime()) };
  }

  @Public()
  @Get('health/ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', database: 'up' };
    } catch (e: any) {
      return { status: 'degraded', database: `down: ${String(e?.message ?? e)}` };
    }
  }
}
