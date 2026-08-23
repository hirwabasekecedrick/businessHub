import { Controller, Get, Post, Body, Param, HttpCode, NotFoundException, ForbiddenException } from '@nestjs/common';
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

    return {
      openCasesByStatus: Object.fromEntries(openByStatus.map((g) => [g.status, g._count])),
      slaAtRisk: { breached, note: 'Cases within 20% of SLA appear pinned in the case list' },
      myTasksDueToday: myTasksToday,
      finance: {
        outstandingTotal: new Prisma.Decimal(invoicesOutstanding._sum.total ?? 0).minus(new Prisma.Decimal(invoicesOutstanding._sum.amountPaid ?? 0)).toString(),
        currency: 'RWF',
      },
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
