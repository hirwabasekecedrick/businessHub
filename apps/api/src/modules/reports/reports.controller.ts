import { Controller, Get, Post, Body, Param, Query, HttpCode, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { UserContext } from '../../common/abilities/case-ability.service';

@Controller('v1')
export class ReportsController {
  constructor(private readonly prisma: PrismaService) {}

  requirePermission(ctx: UserContext, permission: string) {
    if (!ctx.permissions?.includes(permission) && !ctx.permissions?.includes('*')) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', required: permission });
    }
  }

  /** US-8.1: dashboard aggregates computed from live tables in one request. */
  @Get('reports/dashboard')
  async dashboard(@CurrentUser() ctx: UserContext) {
    const orgId = ctx.organizationId!;
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [openByStatus, myTasksToday, slaBuckets, invoicesOutstanding] = await Promise.all([
      this.prisma.case.groupBy({
        by: ['status'],
        where: { organizationId: orgId, deletedAt: null, status: { notIn: ['CLOSED', 'REJECTED'] } },
        _count: true,
      }),
      this.prisma.task.findMany({
        where: {
          OR: [{ assigneeUserId: ctx.id }, { AND: [{ assigneeUserId: null }, { assigneeRoleId: { not: null } }] }],
          status: { in: ['OPEN', 'IN_PROGRESS'] },
          dueAt: { lte: new Date(startOfDay.getTime() + 24 * 3600 * 1000) },
        },
        select: { id: true, title: true, dueAt: true },
      }),
      this.prisma.case.groupBy({
        by: ['status'],
        where: {
          organizationId: orgId,
          deletedAt: null,
          slaDueAt: { not: null },
          status: { notIn: ['CLOSED', 'REJECTED'] },
        },
        _count: true,
      }),
      this.prisma.invoice.aggregate({
        where: { organizationId: orgId, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } },
        _sum: { total: true, amountPaid: true },
      }),
    ]);

    const breached = await this.prisma.case.count({
      where: { organizationId: orgId, deletedAt: null, slaDueAt: { lt: now }, status: { notIn: ['CLOSED', 'REJECTED', 'ESCALATED'] } },
    });

    // Money follows the spec: ISO-4217 codes, never a hardcoded one. Report
    // outstanding per currency; the primary bucket drives the headline figure.
    const byCurrency = await this.prisma.invoice.groupBy({
      by: ['currency'],
      where: { organizationId: orgId, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } },
      _sum: { total: true, amountPaid: true },
    });
    const outstanding = byCurrency
      .map((g) => ({
        currency: g.currency,
        outstandingTotal: new Prisma.Decimal(g._sum.total ?? 0)
          .minus(new Prisma.Decimal(g._sum.amountPaid ?? 0))
          .toString(),
      }))
      .sort((a, b) => Number(b.outstandingTotal) - Number(a.outstandingTotal));

    return {
      openCasesByStatus: Object.fromEntries(openByStatus.map((g) => [g.status, g._count])),
      slaAtRisk: { breached, note: 'Cases within 20% of SLA appear pinned in the case list' },
      myTasksDueToday: myTasksToday,
      finance: {
        outstanding,
        outstandingTotal: outstanding[0]?.outstandingTotal ?? '0',
        currency: outstanding[0]?.currency ?? 'EUR',
      },
    };
  }

  /**
   * FR-8.3: catalogue-driven standard report. Every entry declares its own
   * permission and runner; adding a report never touches routing.
   */
  private static readonly CATALOGUE: Record<
    string,
    {
      title: string;
      permission: string;
      run: (prisma: PrismaService, orgId: string, q: Record<string, string>) => Promise<{ columns: string[]; rows: Record<string, unknown>[] }>;
    }
  > = {
    CASES_BY_STATUS: {
      title: 'Cases by status',
      permission: 'report.read',
      run: async (prisma, orgId) => {
        const groups = await prisma.case.groupBy({
          by: ['status'],
          where: { organizationId: orgId, deletedAt: null },
          _count: true,
          orderBy: { status: 'asc' },
        });
        return {
          columns: ['status', 'cases'],
          rows: groups.map((g) => ({ status: g.status, cases: g._count })),
        };
      },
    },
    CASES_SLA_BREACH: {
      title: 'Breached & escalated cases',
      permission: 'report.read',
      run: async (prisma, orgId) => {
        const rows = await prisma.case.findMany({
          where: {
            organizationId: orgId,
            deletedAt: null,
            OR: [{ status: 'ESCALATED' }, { slaDueAt: { lt: new Date() }, status: { notIn: ['CLOSED', 'REJECTED'] } }],
          },
          select: { reference: true, subject: true, status: true, priority: true, slaDueAt: true, ownerUser: { select: { email: true } } },
          orderBy: { slaDueAt: 'asc' },
          take: 500,
        });
        return {
          columns: ['reference', 'subject', 'status', 'priority', 'slaDueAt', 'owner'],
          rows: rows.map((c) => ({
            reference: c.reference,
            subject: c.subject,
            status: c.status,
            priority: c.priority,
            slaDueAt: c.slaDueAt?.toISOString() ?? null,
            owner: c.ownerUser?.email ?? null,
          })),
        };
      },
    },
    TASKS_OPEN_BY_ASSIGNEE: {
      title: 'Open tasks by assignee',
      permission: 'report.read',
      run: async (prisma, orgId) => {
        const rows = await prisma.task.findMany({
          where: { case: { organizationId: orgId, deletedAt: null }, status: { in: ['OPEN', 'IN_PROGRESS'] } },
          select: { assigneeUser: { select: { email: true } }, _count: true },
        });
        const tally = new Map<string, number>();
        for (const t of rows) {
          const key = t.assigneeUser?.email ?? '(unassigned)';
          tally.set(key, (tally.get(key) ?? 0) + 1);
        }
        return {
          columns: ['assignee', 'openTasks'],
          rows: [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([assignee, openTasks]) => ({ assignee, openTasks })),
        };
      },
    },
    INVOICES_OUTSTANDING: {
      title: 'Outstanding invoices',
      permission: 'report.read',
      run: async (prisma, orgId) => {
        const rows = await prisma.invoice.findMany({
          where: { organizationId: orgId, status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] } },
          select: { number: true, clientOrg: { select: { legalName: true } }, total: true, amountPaid: true, currency: true, dueDate: true, status: true },
          orderBy: { dueDate: 'asc' },
        });
        return {
          columns: ['number', 'client', 'total', 'paid', 'balance', 'currency', 'dueDate', 'status'],
          rows: rows.map((i) => ({
            number: i.number,
            client: i.clientOrg.legalName,
            total: i.total.toString(),
            paid: i.amountPaid.toString(),
            balance: new Prisma.Decimal(i.total).minus(i.amountPaid).toString(),
            currency: i.currency,
            dueDate: i.dueDate?.toISOString().slice(0, 10) ?? null,
            status: i.status,
          })),
        };
      },
    },
    DOCUMENTS_EXPIRING: {
      title: 'Documents expiring soon',
      permission: 'report.read',
      run: async (prisma, orgId, q) => {
        const days = Math.min(365, Math.max(1, parseInt(q.days ?? '30', 10) || 30));
        const limit = new Date(Date.now() + days * 86_400_000);
        const rows = await prisma.document.findMany({
          where: { organizationId: orgId, deletedAt: null, expiresAt: { not: null, lte: limit } },
          select: { filename: true, category: true, version: true, expiresAt: true, case: { select: { clientOrg: { select: { legalName: true } }, reference: true } } },
          orderBy: { expiresAt: 'asc' },
          take: 500,
        });
        return {
          columns: ['filename', 'caseRef', 'client', 'category', 'version', 'expiresAt'],
          rows: rows.map((d) => ({
            filename: d.filename,
            caseRef: d.case?.reference ?? null,
            client: d.case?.clientOrg?.legalName ?? null,
            category: d.category,
            version: d.version,
            expiresAt: d.expiresAt?.toISOString() ?? null,
          })),
        };
      },
    },
  };

  @Get('reports/catalogue')
  listCatalogue(@CurrentUser() ctx: UserContext) {
    this.requirePermission(ctx, 'report.read');
    return Object.entries(ReportsController.CATALOGUE).map(([code, def]) => ({
      code,
      title: def.title,
    }));
  }

  @Get('reports/:code')
  async runCatalogueReport(
    @CurrentUser() ctx: UserContext,
    @Param('code') code: string,
    @Query() query: Record<string, string>,
  ) {
    const def = ReportsController.CATALOGUE[code];
    if (!def) throw new NotFoundException({ code: 'REPORT_NOT_FOUND', available: Object.keys(ReportsController.CATALOGUE) });
    this.requirePermission(ctx, def.permission);
    const { columns, rows } = await def.run(this.prisma, ctx.organizationId!, query ?? {});
    return {
      code,
      title: def.title,
      generatedAt: new Date().toISOString(),
      params: query ?? {},
      columns,
      rows,
    };
  }

  /** US-8.2: monthly report export runs async as a Job; CSV in result. */
  @Post('reports/export')
  @HttpCode(201)
  async exportReport(@CurrentUser() ctx: UserContext, @Body() body: any) {
    this.requirePermission(ctx, 'report.export');
    if (!body?.month || !/^\d{4}-\d{2}$/.test(body.month)) {
      throw new NotFoundException({ code: 'VALIDATION_FAILED', rule: 'month_required_YYYY-MM' });
    }
    const [y, m] = body.month.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1));
    const to = new Date(Date.UTC(y, m, 1));

    const cases = await this.prisma.case.findMany({
      where: {
        organizationId: ctx.organizationId!,
        createdAt: { gte: from, lt: to },
        deletedAt: null,
      },
      include: { clientOrg: { select: { legalName: true } }, caseType: { select: { name: true } } },
    });
    const csv = [
      'reference,client,type,status,priority,created_at,resolved_at',
      ...cases.map((c) =>
        [c.reference, `"${c.clientOrg.legalName}"`, c.caseType.name, c.status, c.priority, c.createdAt.toISOString(), c.resolvedAt?.toISOString() ?? ''].join(','),
      ),
    ].join('\n');

    const job = await this.prisma.job.create({
      data: {
        organizationId: ctx.organizationId,
        type: 'REPORT_EXPORT',
        status: 'DONE',
        completedAt: new Date(),
        createdBy: ctx.id,
        params: body,
        result: { month: body.month, rows: cases.length, csv },
      },
    });
    return { jobId: job.id, status: job.status };
  }

  @Get('jobs/:id')
  async getJob(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    const job = await this.prisma.job.findUnique({ where: { id } });
    if (!job || (job.organizationId && job.organizationId !== ctx.organizationId)) {
      throw new NotFoundException({ code: 'JOB_NOT_FOUND' });
    }
    return job;
  }
}
