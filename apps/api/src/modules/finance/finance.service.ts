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
import { NotificationService } from '../../common/notification.service';
import { renderInvoicePdf } from '../../common/pdf';

const MAX_WEBHOOK_BODY = 1024 * 1024; // FR-6.4: reject bodies over 1MB
const DUNNING_SCHEDULE_DAYS = [7, 14, 30]; // FR-6.8 default dunning schedule
const PDF_URL_TTL_SECONDS = 300;

@Injectable()
export class FinanceService {
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

  /**
   * FR-6.1: creates a DRAFT invoice. Totals are computed server-side only
   * (BR-05); the number is allocated later at issuance (US-6.1).
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

    const { subtotal, taxTotal, total } = computeTotals(lines);

    return this.prisma.invoice.create({
      data: {
        organizationId: ctx.organizationId!,
        clientOrgId: kase.clientOrgId,
        caseId: kase.id,
        number: null,
        status: InvoiceStatus.DRAFT,
        currency: data.currency ?? 'EUR',
        subtotal,
        taxTotal,
        total,
        dueDate: data.dueDate ? new Date(data.dueDate) : new Date(Date.now() + 14 * 24 * 3600 * 1000),
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
  }

  /** FR-6.3: only drafts are editable; issued invoices are immutable. */
  async updateInvoice(ctx: UserContext, id: string, data: any) {
    this.requirePermission(ctx, 'invoice.create');
    const invoice = await this.prisma.invoice.findUnique({ where: { id }, include: { lines: true } });
    if (!invoice || invoice.organizationId !== ctx.organizationId) {
      throw new NotFoundException({ code: 'INVOICE_NOT_FOUND' });
    }
    if (invoice.status !== InvoiceStatus.DRAFT) {
      throw new ConflictException({
        code: 'INVOICE_IMMUTABLE',
        rule: FR63_RULE,
        status: invoice.status,
      });
    }
    const lines = Array.isArray(data.lines) ? data.lines : null;
    return this.prisma.$transaction(async (tx) => {
      let totals = { subtotal: invoice.subtotal, taxTotal: invoice.taxTotal, total: invoice.total };
      if (lines) {
        if (!lines.length) {
          throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', rule: 'lines_required' });
        }
        await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
        await tx.invoiceLine.createMany({
          data: lines.map((l: any, i: number) => ({
            invoiceId: id,
            label: l.label,
            quantity: l.quantity ?? 1,
            unitPrice: l.unitPrice,
            taxRate: l.taxRate ?? 0,
            lineTotal: new Prisma.Decimal(l.quantity ?? 1).mul(new Prisma.Decimal(l.unitPrice)),
            sequence: i,
          })),
        });
        totals = computeTotals(lines);
      }
      return tx.invoice.update({
        where: { id },
        data: {
          subtotal: totals.subtotal,
          taxTotal: totals.taxTotal,
          total: totals.total,
          ...(data.currency ? { currency: data.currency } : {}),
          ...(data.dueDate ? { dueDate: new Date(data.dueDate) } : {}),
        },
        include: { lines: true },
      });
    });
  }

  /**
   * US-6.1 / FR-6.2 / US-6.3: issuing allocates the gapless number inside the
   * same transaction that freezes the invoice. Segregation of duties: the
   * creator cannot issue their own draft unless the organisation has fewer
   * than three finance users (audited override).
   */
  async issueInvoice(ctx: UserContext, id: string) {
    this.requirePermission(ctx, 'invoice.issue');
    if (ctx.isImpersonating) throw new ForbiddenException({ code: 'IMPERSONATION_READ_ONLY' });

    const invoice = await this.prisma.invoice.findUnique({ where: { id }, include: { lines: true } });
    if (!invoice || invoice.organizationId !== ctx.organizationId) {
      throw new NotFoundException({ code: 'INVOICE_NOT_FOUND' });
    }
    if (!invoice.lines.length || !invoice.dueDate) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', rule: 'line_and_due_date_required' });
    }
    if (invoice.status !== InvoiceStatus.DRAFT) {
      throw new ConflictException({ code: 'INVALID_TRANSITION', from: invoice.status, to: 'ISSUED' });
    }

    const financeUserIds = await this.financeUserIds(invoice.organizationId);
    const sodConflict = invoice.createdById === ctx.id;
    const smallOrgOverride = financeUserIds.size < 3;
    if (sodConflict && !smallOrgOverride) {
      throw new ForbiddenException({
        code: 'SEPARATION_OF_DUTIES',
        message: 'A second user with invoice.issue must issue an invoice created by you',
      });
    }

    const issued = await this.prisma.$transaction(async (tx) => {
      const year = new Date().getFullYear();
      // Adopt any pre-existing numbers for this organisation/year so the
      // sequence can never collide with history (gapless guarantee).
      const prefix = `INV-${year}-%`;
      await tx.$executeRaw`
        INSERT INTO "gapless_sequence" ("id", "organizationId", "purpose", "year", "lastValue")
        VALUES (gen_random_uuid(), ${invoice.organizationId}::uuid, 'INVOICE', ${year},
          COALESCE((
            SELECT MAX(NULLIF(regexp_replace("number", '^INV-[0-9]{4}-', ''), '')::bigint)
            FROM "invoice"
            WHERE "organization_id" = ${invoice.organizationId}::uuid AND "number" LIKE ${prefix}
          ), 0) + 1
        )
        ON CONFLICT ("organizationId", "purpose", "year")
        DO UPDATE SET "lastValue" = "gapless_sequence"."lastValue" + 1
      `;
      const rows: any[] =
        await tx.$queryRaw`SELECT "lastValue" FROM "gapless_sequence" WHERE "organizationId" = ${invoice.organizationId}::uuid AND "purpose" = 'INVOICE' AND "year" = ${year}`;
      const seq = Number(rows[0].lastValue);
      const number = `INV-${year}-${String(seq).padStart(5, '0')}`;

      const updated = await tx.invoice.update({
        where: { id },
        data: {
          number,
          status: InvoiceStatus.ISSUED,
          issueDate: new Date(),
          issuedById: ctx.id,
          pdfKey: crypto.randomBytes(12).toString('hex'),
        },
        include: { lines: true },
      });
      return updated;
    });

    if (sodConflict && smallOrgOverride) {
      await this.audit.record({
        actorUserId: ctx.id,
        action: 'finance.sod_override',
        resourceType: 'invoice',
        resourceId: id,
        after: { invoiceNumber: issued.number, financeUsers: financeUserIds.size },
      });
    }

    await this.audit.record({
      actorUserId: ctx.id,
      action: 'INVOICE_ISSUED',
      resourceType: 'invoice',
      resourceId: id,
      before: { status: 'DRAFT' },
      after: { status: 'ISSUED', number: issued.number, total: issued.total.toString() },
    });

    await this.notifyBillingContact(invoice.clientOrgId, 'invoice.issued', {
      invoiceNumber: issued.number,
      total: issued.total.toFixed(2),
      currency: issued.currency,
      dueDate: issued.dueDate?.toISOString().slice(0, 10),
    });

    return issued;
  }

  async listInvoices(ctx: UserContext, status?: string) {
    this.requirePermission(ctx, 'finance.read');
    return this.prisma.invoice.findMany({
      where: {
        OR: [{ organizationId: ctx.organizationId! }, { clientOrgId: ctx.organizationId! }],
        ...(status ? { status: status as InvoiceStatus } : {}),
      },
      include: { lines: true },
      orderBy: { createdAt: 'desc' },
    });

  }

  // ---------- Invoice PDF (FR-6.2) ----------

  private pdfSecret(): string {
    return process.env.PAYMENT_WEBHOOK_SECRET || 'dev-payment-secret';
  }

  signPdfToken(invoiceId: string, jti: string, expSeconds: number): string {
    const exp = Math.floor(Date.now() / 1000) + expSeconds;
    const sig = crypto
      .createHmac('sha256', this.pdfSecret())
      .update(`${invoiceId}.${jti}.${exp}`)
      .digest('hex');
    return `${exp}.${sig}`;
  }

  verifyPdfToken(invoiceId: string, jti: string, token: string): boolean {
    const [expRaw, sig] = String(token ?? '').split('.');
    const exp = Number(expRaw);
    if (!exp || !sig || exp * 1000 < Date.now()) return false;
    const expected = crypto
      .createHmac('sha256', this.pdfSecret())
      .update(`${invoiceId}.${jti}.${exp}`)
      .digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig, 'utf8'));
    } catch {
      return false;
    }
  }

  async pdfUrlFor(ctx: UserContext, id: string) {
    this.requirePermission(ctx, 'finance.read');
    const invoice = await this.prisma.invoice.findUnique({ where: { id } });
    if (!invoice || (invoice.organizationId !== ctx.organizationId && invoice.clientOrgId !== ctx.organizationId)) {
      throw new NotFoundException({ code: 'INVOICE_NOT_FOUND' });
    }
    if (invoice.status === InvoiceStatus.DRAFT || !invoice.pdfKey) {
      throw new ConflictException({ code: 'PDF_NOT_AVAILABLE', reason: 'not_issued' });
    }
    const token = this.signPdfToken(id, invoice.pdfKey, PDF_URL_TTL_SECONDS);
    return { url: `/v1/invoices/${id}/pdf?token=${token}`, expiresIn: PDF_URL_TTL_SECONDS };
  }

  async renderPdf(id: string, token: string): Promise<Buffer> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: { lines: { orderBy: { sequence: 'asc' } }, clientOrg: true },
    });
    if (!invoice || !invoice.pdfKey || !this.verifyPdfToken(id, invoice.pdfKey, token)) {
      throw new UnauthorizedException({ code: 'INVALID_OR_EXPIRED_TOKEN' });
    }
    return renderInvoicePdf({
      number: invoice.number,
      status: invoice.status,
      currency: invoice.currency,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      clientName: invoice.clientOrg?.legalName ?? 'Client',
      lines: invoice.lines.map((l) => ({
        label: l.label,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxRate: l.taxRate,
        lineTotal: l.lineTotal,
      })),
      subtotal: invoice.subtotal,
      taxTotal: invoice.taxTotal,
      total: invoice.total,
      amountPaid: invoice.amountPaid,
    });
  }

  // ---------- Payments ----------

  /**
   * US-6.3 / FR-6.5: manual payment recording. The user who issued the
   * invoice cannot also record its payment.
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
    if (invoice.status === InvoiceStatus.DRAFT || !invoice.issuedById) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', rule: 'invoice_not_issued' });
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
      await this.applyPaymentToInvoice(tx, invoice, amount);
      return p;
    });

    await this.audit.record({
      actorUserId: ctx.id,
      action: 'payment.recorded',
      resourceType: 'payment',
      resourceId: payment.id,
      after: { invoiceNumber: invoice.number, amount: amount.toString() },
    });
    await this.notifications.notify({
      recipientId: invoice.createdById,
      organizationId: invoice.organizationId,
      eventKey: 'payment.received',
      variables: { invoiceNumber: invoice.number, amount: amount.toFixed(2), currency: invoice.currency },
      resourceType: 'invoice',
      resourceId: invoice.id,
    });
    return payment;
  }

  /** US-6.2: refund; the payment recorder cannot approve its own refund. */
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
    if (payment.recordedById === ctx.id && !ctx.permissions.includes('*')) {
      throw new ForbiddenException({
        code: 'SEPARATION_OF_DUTIES',
        message: 'The user who recorded a payment cannot also approve its refund',
      });
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
          status:
            newPaid.eq(0)
              ? InvoiceStatus.ISSUED
              : invoice.status === InvoiceStatus.OVERDUE
                ? InvoiceStatus.OVERDUE
                : InvoiceStatus.PARTIALLY_PAID,
        },
      });
      return updated;
    });
    await this.audit.record({
      actorUserId: ctx.id,
      action: 'payment.refunded',
      resourceType: 'payment',
      resourceId: paymentId,
      before: { status: 'SUCCEEDED' },
      after: { status: 'REFUNDED', reason },
    });
    return result;
  }

  async voidInvoice(ctx: UserContext, id: string) {
    this.requirePermission(ctx, 'invoice.void');
    const invoice = await this.prisma.invoice.findUnique({ where: { id }, include: { payments: true } });
    if (!invoice || invoice.organizationId !== ctx.organizationId) throw new NotFoundException({ code: 'INVOICE_NOT_FOUND' });
    if (invoice.payments.some((p) => p.status === PaymentStatus.SUCCEEDED)) {
      throw new UnprocessableEntityException({ code: 'HAS_PAYMENTS', rule: 'refund_first' });
    }
    if (invoice.status === InvoiceStatus.VOID) {
      throw new ConflictException({ code: 'INVALID_TRANSITION', from: invoice.status, to: 'VOID' });
    }
    const updated = await this.prisma.invoice.update({ where: { id }, data: { status: InvoiceStatus.VOID } });
    await this.audit.record({
      actorUserId: ctx.id,
      action: 'invoice.voided',
      resourceType: 'invoice',
      resourceId: id,
      before: { status: invoice.status },
      after: { status: 'VOID' },
    });
    return updated;
  }

  // ---------- Online payments (FR-6.4 / US-6.2) ----------

  /**
   * Server-side provider handoff: the amount always comes from the database,
   * never from the browser. Idempotent on the caller's intent key.
   */
  async createPaymentIntent(ctx: UserContext, invoiceId: string, intentKey?: string) {
    this.requirePermission(ctx, 'finance.read');
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    // The owning finance org and the billed client org may both start a payment.
    if (!invoice || (invoice.organizationId !== ctx.organizationId && invoice.clientOrgId !== ctx.organizationId)) {
      throw new NotFoundException({ code: 'INVOICE_NOT_FOUND' });
    }
    const payableStatuses: InvoiceStatus[] = [InvoiceStatus.ISSUED, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.OVERDUE];
    if (!payableStatuses.includes(invoice.status)) {
      throw new UnprocessableEntityException({ code: 'NOT_PAYABLE', status: invoice.status });
    }
    const balance = invoice.total.minus(invoice.amountPaid);
    if (balance.lte(0)) {
      throw new UnprocessableEntityException({ code: 'NOT_PAYABLE', reason: 'no_balance' });
    }

    if (intentKey) {
      const existing = await this.prisma.payment.findFirst({
        where: { invoiceId, status: PaymentStatus.INITIATED, rawPayload: { path: ['intentKey'], equals: intentKey } },
      });
      if (existing) return this.intentResponse(existing, balance);
    }

    const payment = await this.prisma.payment.create({
      data: {
        invoiceId,
        provider: 'mock-pay',
        providerRef: `pi_${crypto.randomUUID().replace(/-/g, '')}`,
        method: 'ONLINE',
        amount: balance,
        currency: invoice.currency,
        status: PaymentStatus.INITIATED,
        recordedById: ctx.id,
        rawPayload: { intentKey: intentKey ?? null, startedBy: ctx.id },
      },
    });
    await this.audit.record({
      actorUserId: ctx.id,
      action: 'payment.intent_created',
      resourceType: 'payment',
      resourceId: payment.id,
      after: { invoiceNumber: invoice.number, amount: balance.toString() },
    });
    return this.intentResponse(payment, balance);
  }

  private intentResponse(payment: { id: string; providerRef: string | null; amount: any; currency: string }, _balance: any) {
    return {
      paymentId: payment.id,
      providerRef: payment.providerRef,
      amount: payment.amount.toString(),
      currency: payment.currency,
      handoffUrl: `${process.env.FRONTEND_URL ?? 'http://localhost:3000'}/pay/${payment.id}`,
      expiresIn: 900,
    };
  }

  /**
   * US-6.4 / FR-6.4: payment webhook â€” HMAC-SHA256 signature required,
   * body <= 1MB, replay protection via (provider, providerRef) unique key.
   * A webhook may settle an INITIATED intent or record a direct success;
   * a client-reported outcome alone is never sufficient.
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
    if (existing && existing.status === PaymentStatus.SUCCEEDED) {
      return { duplicate: true, paymentId: existing.id };
    }

    if (existing && existing.status === PaymentStatus.INITIATED) {
      // Settle a started intent (INITIATED -> SUCCEEDED per §10.2).
      const settled = await this.prisma.$transaction(async (tx) => {
        const inv = await tx.invoice.findUnique({ where: { id: existing.invoiceId } });
        if (!inv) throw new NotFoundException({ code: 'INVOICE_NOT_FOUND' });
        const amount = new Prisma.Decimal(amountStr);
        const p = await tx.payment.update({
          where: { id: existing.id },
          data: { status: PaymentStatus.SUCCEEDED, paidAt: new Date(), amount, reconciledAt: new Date(), rawPayload: data },
        });
        await this.applyPaymentToInvoice(tx, inv, amount);
        return p;
      });
      await this.afterWebhookSuccess(settled, data, providerRef);
      return { duplicate: false, paymentId: settled.id, settledIntent: true };
    }

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
          reconciledAt: new Date(),
          rawPayload: data,
        },
      });
      await this.applyPaymentToInvoice(tx, invoice, amount);
      return p;
    });
    await this.afterWebhookSuccess(payment, data, providerRef);
    return { duplicate: false, paymentId: payment.id };
  }

  private async afterWebhookSuccess(
    payment: { id: string; invoiceId: string; amount: any },
    data: any,
    providerRef: string,
  ) {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: payment.invoiceId } });
    await this.audit.record({
      actorUserId: undefined as any,
      action: 'payment.webhook',
      resourceType: 'payment',
      resourceId: payment.id,
      after: { invoiceNumber: invoice?.number, providerRef },
    });
    if (invoice) {
      await this.notifyBillingContact(invoice.clientOrgId, 'payment.received', {
        invoiceNumber: invoice.number,
        amount: new Prisma.Decimal(payment.amount).toFixed(2),
        currency: invoice.currency,
      });
    }
    void data;
  }

  // ---------- Reconciliation (FR-6.9) ----------

  async getReconciliation(ctx: UserContext) {
    this.requirePermission(ctx, 'finance.reconcile');
    const unmatchedPayments = await this.prisma.payment.findMany({
      where: { invoice: { organizationId: ctx.organizationId! }, reconciledAt: null, status: PaymentStatus.SUCCEEDED },
      include: { invoice: { select: { number: true, clientOrgId: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const openInvoices = await this.prisma.invoice.findMany({
      where: {
        organizationId: ctx.organizationId!,
        status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.OVERDUE] },
      },
      select: { id: true, number: true, total: true, amountPaid: true, dueDate: true, clientOrgId: true, currency: true },
      orderBy: { dueDate: 'asc' },
    });
    return {
      unmatchedPayments: unmatchedPayments.map((p) => ({
        id: p.id,
        provider: p.provider,
        providerRef: p.providerRef,
        amount: p.amount.toString(),
        currency: p.currency,
        paidAt: p.paidAt,
        invoiceNumber: p.invoice?.number ?? null,
      })),
      openInvoices: openInvoices.map((i) => ({
        id: i.id,
        number: i.number,
        currency: i.currency,
        total: i.total.toString(),
        balance: i.total.minus(i.amountPaid).toString(),
        dueDate: i.dueDate,
      })),
    };
  }

  /** Manual matching: re-home a payment onto an open invoice and reconcile both sides. */
  async matchPayment(ctx: UserContext, paymentId: string, targetInvoiceId: string) {
    this.requirePermission(ctx, 'finance.reconcile');
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException({ code: 'PAYMENT_NOT_FOUND' });
    const target = await this.prisma.invoice.findUnique({ where: { id: targetInvoiceId } });
    if (!target || target.organizationId !== ctx.organizationId) {
      throw new NotFoundException({ code: 'INVOICE_NOT_FOUND' });
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const previous =
        payment.invoiceId !== targetInvoiceId
          ? await tx.invoice.findUnique({ where: { id: payment.invoiceId } })
          : null;
      if (previous) {
        const paid = previous.amountPaid.minus(payment.status === PaymentStatus.SUCCEEDED ? payment.amount : 0);
        const maxPaid = paid.lt(0) ? new Prisma.Decimal(0) : paid;
        await tx.invoice.update({
          where: { id: previous.id },
          data: {
            amountPaid: maxPaid,
            status: maxPaid.eq(0)
              ? InvoiceStatus.ISSUED
              : previous.total.minus(maxPaid).gt(0)
                ? InvoiceStatus.PARTIALLY_PAID
                : InvoiceStatus.PAID,
          },
        });
      }
      await tx.payment.update({
        where: { id: paymentId },
        data: { invoiceId: targetInvoiceId, reconciledAt: new Date() },
      });
      const fresh = await tx.invoice.findUnique({ where: { id: targetInvoiceId }, include: { payments: true } });
      if (fresh) {
        const succeeded = fresh.payments
          .filter((p) => p.status === PaymentStatus.SUCCEEDED)
          .reduce((acc, p) => acc.plus(p.amount), new Prisma.Decimal(0));
        const capped = succeeded.gt(fresh.total) ? fresh.total : succeeded;
        await tx.invoice.update({
          where: { id: targetInvoiceId },
          data: {
            amountPaid: capped,
            status: capped.gte(fresh.total)
              ? InvoiceStatus.PAID
              : fresh.status === InvoiceStatus.OVERDUE
                ? InvoiceStatus.OVERDUE
                : InvoiceStatus.PARTIALLY_PAID,
          },
        });
      }
      return tx.payment.findUnique({ where: { id: paymentId } });
    });
    await this.audit.record({
      actorUserId: ctx.id,
      action: 'finance.reconciled',
      resourceType: 'payment',
      resourceId: paymentId,
      after: { invoiceId: targetInvoiceId, invoiceNumber: target.number },
    });
    return result;
  }

  // ---------- Statement & sweeps ----------

  /** US-6.5: statement with running balance and ageing buckets. */
  async getStatement(ctx: UserContext, clientId: string) {
    this.requirePermission(ctx, 'finance.read');
    const invoices = await this.prisma.invoice.findMany({
      where: {
        clientOrgId: clientId,
        OR: [{ organizationId: ctx.organizationId! }, { clientOrgId: ctx.organizationId! }],
      },
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
      currency: invoices[0]?.currency ?? 'EUR',
      entries,
      summary: {
        outstandingTotal: outstanding.toString(),
        overdueTotal: overdue.toString(),
        ageing: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.toString()])),
      },
    };
  }

  /**
   * US-6.4 / FR-6.8: overdue sweep marks OVERDUE once per invoice and sends
   * exactly one dunning reminder per schedule point (7/14/30 days past due).
   * Idempotent: reminders are tracked via notification rows keyed on the
   * invoice id and schedule day.
   */
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
      marked.push(inv.number ?? inv.id);
    }
    const reminders: string[] = [];
    const overdueOpen = await this.prisma.invoice.findMany({
      where: {
        organizationId: ctx.organizationId!,
        status: { in: [InvoiceStatus.OVERDUE] },
      },
    });
    for (const inv of overdueOpen) {
      const balance = inv.total.minus(inv.amountPaid);
      if (balance.lte(0) || !inv.dueDate) continue;
      const daysLate = Math.floor((now.getTime() - inv.dueDate.getTime()) / 86400000);
      for (const day of DUNNING_SCHEDULE_DAYS) {
        if (daysLate < day) continue;
        const already = await this.prisma.notification.findFirst({
          where: {
            templateCode: 'invoice.overdue',
            resourceType: 'invoice',
            resourceId: inv.id,
            payload: { path: ['variables', 'dunningDay'], equals: day },
          },
        });
        if (already) continue;
        await this.notifyBillingContact(
          inv.clientOrgId,
          'invoice.overdue',
          { invoiceNumber: inv.number, dunningDay: day, balance: balance.toFixed(2), currency: inv.currency },
          inv.id,
        );
        reminders.push(`${inv.number}:${day}`);
      }
    }
    return {
      sweptAt: now.toISOString(),
      markedCount: marked.length,
      markedNumbers: marked,
      remindersSent: reminders.length,
      reminders,
    };
  }

  // ---------- helpers ----------

  private async applyPaymentToInvoice(
    tx: { invoice: { update: (args: any) => Promise<any> } },
    invoice: { id: string; total: any; amountPaid: any; status: InvoiceStatus },
    amount: Prisma.Decimal,
  ) {
    const newPaid = invoice.amountPaid.add(amount);
    const fullyPaid = newPaid.gte(invoice.total);
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        amountPaid: fullyPaid ? invoice.total : newPaid,
        status: fullyPaid ? InvoiceStatus.PAID : this.balanceStatusFor(invoice, newPaid),
      },
    });
    if (fullyPaid) {
      // US-6.4: pending reminders are cancelled, not merely suppressed.
      await (tx as any).notification.deleteMany({
        where: { resourceType: 'invoice', resourceId: invoice.id, templateCode: 'invoice.overdue', status: 'QUEUED' },
      });
    }
  }

  private balanceStatusFor(invoice: { status: InvoiceStatus }, newPaid: any): InvoiceStatus {
    if (invoice.status === InvoiceStatus.OVERDUE) return InvoiceStatus.OVERDUE;
    return newPaid.gt(0) ? InvoiceStatus.PARTIALLY_PAID : invoice.status;
  }

  private async financeUserIds(organizationId: string): Promise<Set<string>> {
    const members = await this.prisma.membership.findMany({
      where: { organizationId, deletedAt: null },
      include: { role: { select: { permissions: true } }, user: { select: { status: true } } },
    });
    const ids = members
      .filter((m) => {
        if (m.user.status !== 'ACTIVE') return false;
        const perms = (m.role.permissions as string[]) ?? [];
        return perms.includes('*') || perms.includes('invoice.issue');
      })
      .map((m) => m.userId);
    return new Set(ids);
  }

  private async notifyBillingContact(
    clientOrgId: string,
    eventKey: string,
    variables: Record<string, any>,
    resourceId?: string,
  ) {
    const membership = await this.prisma.membership.findFirst({
      where: { organizationId: clientOrgId, deletedAt: null, role: { code: 'Client' } },
      select: { userId: true },
    });
    const fallbackMembership = membership
      ? null
      : await this.prisma.membership.findFirst({
          where: { organizationId: clientOrgId, deletedAt: null },
          select: { userId: true },
        });
    const recipientId = membership?.userId ?? fallbackMembership?.userId;
    if (!recipientId) return;
    await this.notifications.notify({
      recipientId,
      organizationId: clientOrgId,
      eventKey,
      variables,
      resourceType: resourceId ? 'invoice' : undefined,
      resourceId: resourceId ?? undefined,
    });
  }
}

const FR63_RULE = 'issued invoices are immutable; corrections happen through credit notes';

function computeTotals(lines: any[]) {
  const subtotal = lines.reduce(
    (acc: any, l: any) => acc.plus(new Prisma.Decimal(l.quantity ?? 1).mul(new Prisma.Decimal(l.unitPrice))),
    new Prisma.Decimal(0),
  );
  const taxTotal = lines.reduce(
    (acc: any, l: any) =>
      acc.plus(
        new Prisma.Decimal(l.quantity ?? 1).mul(new Prisma.Decimal(l.unitPrice)).mul(new Prisma.Decimal(l.taxRate ?? 0)).div(100),
      ),
    new Prisma.Decimal(0),
  );
  return { subtotal, taxTotal, total: subtotal.plus(taxTotal) };
}
