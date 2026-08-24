import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  Res,
  HttpCode,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import { FinanceService } from './finance.service';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { UserContext } from '../../common/abilities/case-ability.service';

@Controller('v1')
export class FinanceController {
  constructor(private readonly financeService: FinanceService) {}

  @Post('invoices')
  async createInvoice(@CurrentUser() ctx: UserContext, @Body() body: any) {
    return this.financeService.createInvoice(ctx, body);
  }

  /** FR-6.3: edit a draft; issued invoices are immutable. */
  @Patch('invoices/:id')
  async updateInvoice(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() body: any) {
    return this.financeService.updateInvoice(ctx, id, body);
  }

  @Get('invoices')
  async listInvoices(@CurrentUser() ctx: UserContext, @Query('status') status?: string) {
    return this.financeService.listInvoices(ctx, status);
  }

  /** US-6.1 / FR-6.2: allocate the gapless number and freeze the invoice. */
  @Post('invoices/:id/issue')
  async issueInvoice(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.financeService.issueInvoice(ctx, id);
  }

  /** FR-6.2: time-limited link to the rendered invoice PDF. */
  @Get('invoices/:id/pdf-url')
  async pdfUrl(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.financeService.pdfUrlFor(ctx, id);
  }

  /** Token-authenticated (HMAC, 5-minute TTL); no session required. */
  @Public()
  @Get('invoices/:id/pdf')
  async getPdf(@Param('id') id: string, @Query('token') token: string, @Res() res: Response) {
    const pdf = await this.financeService.renderPdf(id, token ?? '');
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `inline; filename="invoice-${id}.pdf"`);
    res.send(pdf);
  }

  /** FR-6.4 / US-6.2: server-side provider handoff for online payment. */
  @Post('invoices/:id/payment-intents')
  async createPaymentIntent(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() body: any) {
    return this.financeService.createPaymentIntent(ctx, id, body?.intentKey);
  }

  /** FR-6.9: unmatched payments against open invoices. */
  @Get('finance/reconciliation')
  async reconciliation(@CurrentUser() ctx: UserContext) {
    return this.financeService.getReconciliation(ctx);
  }

  @Post('finance/reconciliation/match')
  @HttpCode(200)
  async matchPayment(@CurrentUser() ctx: UserContext, @Body() body: any) {
    if (!body?.paymentId || !body?.invoiceId) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED', rule: 'paymentId_and_invoiceId_required' });
    }
    return this.financeService.matchPayment(ctx, body.paymentId, body.invoiceId);
  }

  /** Public webhook; HMAC-SHA256 over the raw body in x-signature. */
  @Public()
  @HttpCode(200)
  @Post('webhooks/payment')
  async paymentWebhook(@Req() req: any) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    this.financeService.checkWebhookSize(raw);
    if (!this.financeService.verifyWebhookSignature(raw, req.headers['x-signature'])) {
      throw new UnauthorizedException({ code: 'INVALID_SIGNATURE' });
    }
    return this.financeService.paymentWebhook(req.body);
  }

  @Get('clients/:id/statement')
  async getStatement(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.financeService.getStatement(ctx, id);
  }

  @Post('invoices/:id/payments')
  async recordPayment(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() body: any) {
    return this.financeService.recordPayment(ctx, id, body);
  }

  @Post('payments/:id/refund')
  @HttpCode(200)
  async refundPayment(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() body: any) {
    return this.financeService.refundPayment(ctx, id, body?.reason ?? '');
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  async voidInvoice(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.financeService.voidInvoice(ctx, id);
  }

  /** Idempotent overdue sweep + dunning reminders — safe to call repeatedly. */
  @Post('finance/overdue-sweep')
  @HttpCode(200)
  async sweepOverdue(@CurrentUser() ctx: UserContext) {
    return this.financeService.sweepOverdue(ctx);
  }
}
