import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  HttpCode,
  ForbiddenException,
} from '@nestjs/common';
import { CasesService } from './cases.service';
import { CaseStatus } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { UserContext } from '../../common/abilities/case-ability.service';

@Controller('v1/cases')
export class CasesController {
  constructor(private readonly casesService: CasesService) {}

  @Get()
  async listCases(@CurrentUser() ctx: UserContext, @Query() query: any) {
    return this.casesService.listCases(ctx, query);
  }

  @Post()
  async createCase(@CurrentUser() ctx: UserContext, @Body() body: any) {
    return this.casesService.createCase(ctx, body);
  }

  @Post('bulk/assign')
  @HttpCode(200)
  async bulkAssign(
    @CurrentUser() ctx: UserContext,
    @Body() body: { caseIds: string[]; ownerUserId: string },
  ) {
    return this.casesService.bulkAssign(ctx, body.caseIds, body.ownerUserId);
  }

  @Post('export')
  @HttpCode(200)
  async exportCases(@CurrentUser() ctx: UserContext, @Body() body: any) {
    return this.casesService.exportCases(ctx, body);
  }

  @Get(':id')
  async getCase(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.casesService.getCase(ctx, id);
  }

  @Patch(':id')
  async updateCase(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() body: any) {
    return this.casesService.updateCase(ctx, id, body);
  }

  @Post(':id/submit')
  @HttpCode(200)
  async submitCase(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.casesService.submitCase(ctx, id);
  }

  @Post(':id/qualify')
  @HttpCode(200)
  async qualifyCase(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() body: any) {
    return this.casesService.transitionCase(ctx, id, CaseStatus.QUALIFIED, undefined, body);
  }

  @Post(':id/assign')
  @HttpCode(200)
  async assignCase(
    @CurrentUser() ctx: UserContext,
    @Param('id') id: string,
    @Body() body: { ownerUserId: string },
  ) {
    if (!body.ownerUserId) {
      throw new ForbiddenException({ code: 'VALIDATION_FAILED', rule: 'owner_user_id_required' });
    }
    return this.casesService.assignCase(ctx, id, body.ownerUserId);
  }

  @Post(':id/hold')
  @HttpCode(200)
  async holdCase(
    @CurrentUser() ctx: UserContext,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return this.casesService.holdCase(ctx, id, body.reason);
  }

  @Post(':id/resume')
  @HttpCode(200)
  async resumeCase(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.casesService.resumeCase(ctx, id);
  }

  @Post(':id/close')
  @HttpCode(200)
  async closeCase(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.casesService.closeCase(ctx, id);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  async reopenCase(
    @CurrentUser() ctx: UserContext,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return this.casesService.reopenCase(ctx, id, body.reason);
  }

  @Get(':id/history')
  async getHistory(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.casesService.getHistory(ctx, id);
  }

  @Get(':id/comments')
  async getComments(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.casesService.getCaseComments(ctx, id);
  }

  @Post(':id/comments')
  async addComment(
    @CurrentUser() ctx: UserContext,
    @Param('id') id: string,
    @Body() body: { body: string; isInternal?: boolean },
  ) {
    return this.casesService.addComment(ctx, id, body.body, !!body.isInternal);
  }

  @Post(':id/transition')
  @HttpCode(200)
  async transitionCase(
    @CurrentUser() ctx: UserContext,
    @Param('id') id: string,
    @Body() body: { toStatus: CaseStatus; reason?: string },
  ) {
    return this.casesService.transitionCase(ctx, id, body.toStatus, body.reason);
  }
}
