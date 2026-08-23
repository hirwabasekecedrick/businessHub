import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  UnauthorizedException,
} from '@nestjs/common';
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

  @Get('invoices')
  async listInvoices(@CurrentUser() ctx: UserContext, @Query('status') status?: string) {
    return this.financeService.listInvoices(ctx, status);
  }

  /** Public webhook; HMAC-SHA256 over the raw body in x-signature. */
  @Public()
  @Post('webhooks/payment')
  @HttpCode(200)
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

  /** Idempotent overdue sweep — safe to call repeatedly. */
  @Post('finance/overdue-sweep')
  @HttpCode(200)
  async sweepOverdue(@CurrentUser() ctx: UserContext) {
    return this.financeService.sweepOverdue(ctx);
  }
}
