import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
} from '@nestjs/common';
import { CrmService } from './crm.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { UserContext } from '../../common/abilities/case-ability.service';

@Controller('v1')
export class CrmController {
  constructor(private readonly crmService: CrmService) {}

  @Post('organisations')
  async createOrganisation(@CurrentUser() ctx: UserContext, @Body() body: any) {
    return this.crmService.createOrganisation(ctx, body);
  }

  @Get('clients')
  async getClients(@CurrentUser() ctx: UserContext) {
    return this.crmService.getClients(ctx);
  }

  @Get('partners')
  async getPartners(@CurrentUser() ctx: UserContext) {
    return this.crmService.getPartners(ctx);
  }

  @Get('clients/:id/overview')
  async getClientOverview(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.crmService.getClientOverview(ctx, id);
  }

  @Get('contacts')
  async listContacts(@CurrentUser() ctx: UserContext, @Query('organizationId') organizationId?: string) {
    return this.crmService.listContacts(ctx, organizationId);
  }

  @Post('contacts')
  async createContact(@CurrentUser() ctx: UserContext, @Body() body: any) {
    return this.crmService.createContact(ctx, body);
  }

  @Patch('contacts/:id')
  async updateContact(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() body: any) {
    return this.crmService.updateContact(ctx, id, body);
  }

  @Delete('contacts/:id')
  async deleteContact(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.crmService.deleteContact(ctx, id);
  }

  /** Body is either the consents map itself or { consents: {...} }. */
  @Post('contacts/:id/consents')
  @HttpCode(200)
  async updateConsents(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() body: any) {
    const consents = body?.marketing !== undefined || body?.dataProcessing !== undefined ? body : (body?.consents ?? {});
    return this.crmService.updateConsents(ctx, id, consents);
  }

  @Post('contacts/:id/portal-access')
  @HttpCode(200)
  async grantPortalAccess(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.crmService.grantPortalAccess(ctx, id);
  }

  @Get('crm/segments')
  async getSegments(@CurrentUser() ctx: UserContext, @Query('segment') segment?: string) {
    return this.crmService.getSegments(ctx, segment);
  }

  @Post('crm/export')
  @HttpCode(200)
  async exportCrm(@CurrentUser() ctx: UserContext) {
    return this.crmService.exportCrm(ctx);
  }

  /** FR-2.7: cross-module full-text search (?q=&limit=). */
  @Get('search')
  async search(@CurrentUser() ctx: UserContext, @Query('q') q?: string, @Query('limit') limit?: string) {
    return this.crmService.search(ctx, q ?? '', limit ? Number(limit) : undefined);
  }

  /** US-2.3: idempotent compliance sweep (expiring docs, AT_RISK, recovery). */
  @Post('crm/compliance/sweep')
  @HttpCode(200)
  async sweepCompliance(@CurrentUser() ctx: UserContext) {
    return this.crmService.sweepCompliance(ctx);
  }
}
