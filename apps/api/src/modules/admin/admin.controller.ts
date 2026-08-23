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

  /** US-9.1: export runs as a Job; result carries the CSV payload. */
  @Post('admin/audit/export')
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
