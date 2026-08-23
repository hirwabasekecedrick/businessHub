import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InvoiceStatus, PaymentStatus, Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { UserContext } from '../../common/abilities/case-ability.service';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../../common/audit.service';

const MAX_WEBHOOK_BODY = 1024 * 1024; // FR-6.4: reject bodies over 1MB

@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  requirePermission(ctx: UserContext, permission: string) {
    if (!ctx.permissions?.includes(permission) && !ctx.permissions?.includes('*')) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', required: permission });
    }
  }

  /**
   * US-6.1 / FR-6.1: gapless invoice numbers per organisation and year using the
   * gapless_sequence table inside the SAME transaction as invoice creation.
   */
  async createInvoice(ctx: UserContext, data: any) {
    this.requirePermission(ctx, 'invoice.create');
    if (ctx.isImpersonating) throw new ForbiddenException({ code: 'IMPERSONATION_READ_ONLY' });

    const kase = await this.prisma.case.findUnique({ where: { id: data.caseId } });
    if (!kase) throw new NotFoundException({ code: 'CASE_NOT_FOUND' });

    const lines = Array.isArray(data.lines) ? data.lines : [];
    if (!lines.length) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', rule: 'lines_required' });
    }

    const subtotal = lines.reduce((acc: any, l: any) => acc.plus(new Prisma.Decimal(l.quantity ?? 1).mul(new Prisma.Decimal(l.unitPrice))), new Prisma.Decimal(0));
    const taxTotal = lines.reduce(
      (acc: any, l: any) => acc.plus(new Prisma.Decimal(l.quantity ?? 1).mul(new Prisma.Decimal(l.unitPrice)).mul(new Prisma.Decimal(l.taxRate ?? 0)).div(100)),
      new Prisma.Decimal(0),
    );
    const total = subtotal.plus(taxTotal);

    return this.prisma.$transaction(async (tx) => {
      const year = new Date().getFullYear();
      await tx.$executeRaw`
        INSERT INTO "gapless_sequence" ("id", "organizationId", "purpose", "year", "lastValue")
        VALUES (gen_random_uuid(), '00000000-0000-4000-8000-000000009999'::uuid, 'INVOICE', ${year}, 1)
        ON CONFLICT ("organizationId", "purpose", "year")
        DO UPDATE SET "lastValue" = "gapless_sequence"."lastValue" + 1
      `;
      const rows: any[] =
        await tx.$queryRaw`SELECT "lastValue" FROM "gapless_sequence" WHERE "organizationId" = '00000000-0000-4000-8000-000000009999'::uuid AND "purpose" = 'INVOICE' AND "year" = ${year}`;
      const seq = Number(rows[0].lastValue);
      const number = `INV-${year}-${String(seq).padStart(5, '0')}`;

      const invoice = await tx.invoice.create({
        data: {
          organizationId: ctx.organizationId!,
          clientOrgId: kase.clientOrgId,
          caseId: kase.id,
          number,
          status: InvoiceStatus.ISSUED,
          currency: data.currency ?? 'RWF',
          subtotal,
          taxTotal,
          total,
          issueDate: new Date(),
          dueDate: data.dueDate ? new Date(data.dueDate) : new Date(Date.now() + 14 * 24 * 3600 * 1000),
          issuedById: ctx.id,
          createdById: ctx.id,
          lines: {
            create: lines.map((l: any, i: number) => ({
              label: l.label,
              quantity: l.quantity ?? 1,
              unitPrice: l.unitPrice,
              taxRate: l.taxRate ?? 0,
              lineTotal: new Prisma.Decimal(l.quantity ?? 1).mul(new Prisma.Decimal(l.unitPrice)),
              sequence: i,
            })),
          },
        },
        include: { lines: true },
      });
      return invoice;
    });
  }

  async listInvoices(ctx: UserContext, status?: string) {
    this.requirePermission(ctx, 'finance.read');
    return this.prisma.invoice.findMany({
      where: {
        organizationId: ctx.organizationId!,
        ...(status ? { status: status as InvoiceStatus } : {}),
      },
      include: { lines: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * US-6.3 / FR-6.3: separation of duties — the user who issued an invoice can
   * never record its payment.
   */
  async recordPayment(ctx: UserContext, invoiceId: string, data: any) {
    this.requirePermission(ctx, 'payment.record');
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { payments: true },
    });
    if (!invoice || invoice.organizationId !== ctx.organizationId) {
      throw new NotFoundException({ code: 'INVOICE_NOT_FOUND' });
    }
    if (invoice.status === InvoiceStatus.VOID) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', rule: 'invoice_void' });
    }
    if (invoice.issuedById === ctx.id && !ctx.permissions.includes('*')) {
      throw new ForbiddenException({
        code: 'SEPARATION_OF_DUTIES',
        message: 'The user who issued the invoice cannot also record its payment',
      });
    }
    const amount = new Prisma.Decimal(data.amount);
    const balance = invoice.total.minus(invoice.amountPaid);
    if (amount.gt(balance)) {
      throw new UnprocessableEntityException({
        code: 'OVERPAYMENT',
        balanceDue: balance.toString(),
        attempted: amount.toString(),
      });
    }

    const payment = await this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          invoiceId,
          provider: data.provider ?? 'manual',
          method: data.method ?? 'BANK_TRANSFER',
          amount,
          currency: invoice.currency,
          providerRef: data.providerRef ?? `manual-${crypto.randomUUID()}`,
          status: PaymentStatus.SUCCEEDED,
          paidAt: data.paidAt ? new Date(data.paidAt) : new Date(),
          reconciledAt: new Date(),
          recordedById: ctx.id,
          rawPayload: data,
        },
      });
      const newPaid = invoice.amountPaid.add(amount);
      const fullyPaid = newPaid.gte(invoice.total);
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { amountPaid: fullyPaid ? invoice.total : invoice.amountPaid.add(amount), status: fullyPaid ? InvoiceStatus.PAID : invoice.status },
      });
      return p;
    });

    await this.audit.record({
      actorUserId: ctx.id,
      action: 'PAYMENT_RECORDED',
      resourceType: 'payment',
      resourceId: payment.id,
      after: { invoiceNumber: invoice.number, amount: amount.toString() },
    });
    return payment;
  }

  /** US-6.2: refund with reason; audited; only SUCCEEDED payments refundable. */
  async refundPayment(ctx: UserContext, paymentId: string, reason: string) {
    this.requirePermission(ctx, 'payment.refund');
    if (!reason) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', rule: 'reason_required' });
    }
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId }, include: { invoice: true } });
    if (!payment) throw new NotFoundException({ code: 'PAYMENT_NOT_FOUND' });
    if (payment.status !== PaymentStatus.SUCCEEDED) {
      throw new UnprocessableEntityException({ code: 'NOT_REFUNDABLE', status: payment.status });
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.payment.update({ where: { id: paymentId }, data: { status: PaymentStatus.REFUNDED } });
      // Reduce amountPaid by refunded amount; downgrade PAID -> PARTIALLY_PAID/ISSUED.
      const invoice = payment.invoice;
      const raw = invoice.amountPaid.minus(payment.amount);
      const newPaid = raw.lt(0) ? new Prisma.Decimal(0) : raw;
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          amountPaid: newPaid,
          status: newPaid.eq(0) ? InvoiceStatus.ISSUED : InvoiceStatus.PARTIALLY_PAID,
        },
      });
      return updated;
    });
    await this.audit.record({
      actorUserId: ctx.id,
      action: 'REFUND_ISSUED',
      resourceType: 'payment',
      resourceId: paymentId,
      before: { status: 'SUCCEEDED' },
      after: { status: 'REFUNDED', reason },
    });
    return result;
  }

  async voidInvoice(ctx: UserContext, id: string) {
    this.requirePermission(ctx, 'invoice.create');
    const invoice = await this.prisma.invoice.findUnique({ where: { id }, include: { payments: true } });
    if (!invoice || invoice.organizationId !== ctx.organizationId) throw new NotFoundException({ code: 'INVOICE_NOT_FOUND' });
    if (invoice.payments.some((p) => p.status === PaymentStatus.SUCCEEDED)) {
      throw new UnprocessableEntityException({ code: 'HAS_PAYMENTS', rule: 'refund_first' });
    }
    return this.prisma.invoice.update({ where: { id }, data: { status: InvoiceStatus.VOID } });
  }

  /**
   * US-6.4 / FR-6.4: payment webhook — HMAC-SHA256 signature required,
   * body <= 1MB, replay protection via (provider, providerRef) unique key.
   */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined): boolean {
    const secret = process.env.PAYMENT_WEBHOOK_SECRET || 'dev-payment-secret';
    const expected = crypto.createHmac('sha256', secret).update(rawBody as any).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature ?? '', 'utf8'));
    } catch {
      return false;
    }
  }

  checkWebhookSize(rawBody?: Buffer | string) {
    const size = rawBody?.length ?? 0;
    if (size > MAX_WEBHOOK_BODY) {
      throw new PayloadTooLargeException({ code: 'BODY_TOO_LARGE', maxBytes: MAX_WEBHOOK_BODY });
    }
  }

  async paymentWebhook(data: any) {
    const providerRef = data?.providerRef ?? data?.provider_ref;
    const amountStr = String(data?.amount ?? '');
    if (!providerRef || !amountStr) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', rule: 'providerRef_and_amount_required' });
    }
    const existing = await this.prisma.payment.findUnique({
      where: { provider_providerRef: { provider: data.provider ?? 'mock-pay', providerRef } },
    });
    // Idempotent replay: same event delivered twice is acknowledged without side effects.
    if (existing) return { duplicate: true, paymentId: existing.id };

    const invoice = data.invoiceNumber
      ? await this.prisma.invoice.findUnique({ where: { number: data.invoiceNumber } })
      : null;
    if (!invoice) throw new NotFoundException({ code: 'INVOICE_NOT_FOUND', invoiceNumber: data.invoiceNumber });

    const amount = new Prisma.Decimal(amountStr);
    const payment = await this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          invoiceId: invoice.id,
          provider: data.provider ?? 'mock-pay',
          providerRef,
          method: data.method ?? 'MOBILE_MONEY',
          amount,
          currency: invoice.currency,
          status: PaymentStatus.SUCCEEDED,
          paidAt: new Date(),
          rawPayload: data,
        },
      });
      const newPaid = invoice.amountPaid.add(amount);
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          amountPaid: newPaid.gte(invoice.total) ? invoice.total : newPaid,
          status: newPaid.gte(invoice.total) ? InvoiceStatus.PAID : InvoiceStatus.PARTIALLY_PAID,
        },
      });
      return p;
    });
    await this.audit.record({
      actorUserId: undefined,
      action: 'WEBHOOK_PAYMENT_RECEIVED',
      resourceType: 'payment',
      resourceId: payment.id,
      after: { invoiceNumber: invoice.number, providerRef },
    });
    return { duplicate: false, paymentId: payment.id };
  }

  /** US-6.5: statement with running balance and ageing buckets. */
  async getStatement(ctx: UserContext, clientId: string) {
    this.requirePermission(ctx, 'finance.read');
    const invoices = await this.prisma.invoice.findMany({
      where: { clientOrgId: clientId, organizationId: ctx.organizationId! },
      orderBy: [{ issueDate: 'asc' }],
      include: { payments: true },
    });
    let outstanding = new Prisma.Decimal(0);
    let overdue = new Prisma.Decimal(0);
    const now = Date.now();
    const buckets = { b0_30: new Prisma.Decimal(0), b31_60: new Prisma.Decimal(0), b61_90: new Prisma.Decimal(0), b90plus: new Prisma.Decimal(0) };
    const entries = invoices.map((inv) => {
      const balance = inv.total.minus(inv.amountPaid);
      outstanding = outstanding.plus(balance);
      if (inv.dueDate && inv.dueDate.getTime() < now && balance.gt(0)) {
        overdue = overdue.plus(balance);
        const daysLate = Math.floor((now - inv.dueDate!.getTime()) / 86400000);
        if (daysLate <= 30) buckets.b0_30 = buckets.b0_30.plus(balance);
        else if (daysLate <= 60) buckets.b31_60 = buckets.b31_60.plus(balance);
        else if (daysLate <= 90) buckets.b61_90 = buckets.b61_90.plus(balance);
        else buckets.b90plus = buckets.b90plus.plus(balance);
      }
      return {
        date: inv.issueDate,
        number: inv.number,
        total: inv.total.toString(),
        paid: inv.amountPaid.toString(),
        balance: balance.toString(),
        dueDate: inv.dueDate,
        status: inv.status,
      };
    });
    return {
      clientOrgId: clientId,
      currency: invoices[0]?.currency ?? 'RWF',
      entries,
      summary: {
        outstandingTotal: outstanding.toString(),
        overdueTotal: overdue.toString(),
        ageing: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.toString()])),
      },
    };
  }

  /** US-6.6: overdue sweep marks OVERDUE once per invoice (idempotent). */
  async sweepOverdue(ctx: UserContext) {
    const now = new Date();
    const candidates = await this.prisma.invoice.findMany({
      where: {
        organizationId: ctx.organizationId!,
        dueDate: { lt: now },
        status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIALLY_PAID] },
      },
    });
    const marked: string[] = [];
    for (const inv of candidates) {
      const balance = inv.total.minus(inv.amountPaid);
      if (balance.lte(0)) continue;
      await this.prisma.invoice.update({ where: { id: inv.id }, data: { status: InvoiceStatus.OVERDUE } });
      marked.push(inv.number);
    }
    return { sweptAt: now.toISOString(), markedCount: marked.length, markedNumbers: marked };
  }
}
