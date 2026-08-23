import {
  Controller,
  Put,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  HttpCode,
} from '@nestjs/common';
import { WorkflowService } from './workflow.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { UserContext } from '../../common/abilities/case-ability.service';

@Controller('v1')
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  // --- TASKS ---

  @Get('tasks')
  async getTasks(@CurrentUser() ctx: UserContext, @Query('assignee') assignee?: string) {
    return this.workflowService.getTasks(ctx, assignee === 'me');
  }

  @Post('tasks')
  async createTask(@CurrentUser() ctx: UserContext, @Body() body: any) {
    return this.workflowService.createTask(ctx, body);
  }

  @Patch('tasks/:id')
  async updateTask(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() body: any) {
    return this.workflowService.updateTask(ctx, id, body);
  }

  @Post('tasks/:id/claim')
  @HttpCode(200)
  async claimTask(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.workflowService.claimTask(ctx, id);
  }

  @Post('tasks/:id/reassign')
  @HttpCode(200)
  async reassignTask(
    @CurrentUser() ctx: UserContext,
    @Param('id') id: string,
    @Body() body: { assigneeUserId: string; reason?: string },
  ) {
    return this.workflowService.reassignTask(ctx, id, body.assigneeUserId, body.reason);
  }

  @Post('tasks/:id/complete')
  @HttpCode(200)
  async completeTask(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.workflowService.completeTask(ctx, id);
  }

  @Post('tasks/:id/block')
  @HttpCode(200)
  async blockTask(
    @CurrentUser() ctx: UserContext,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return this.workflowService.blockTask(ctx, id, body.reason);
  }

  // --- APPROVALS ---

  @Get('approvals')
  async getApprovals(@CurrentUser() ctx: UserContext) {
    return this.workflowService.getApprovals(ctx);
  }

  @Post('approvals/:id/decide')
  @HttpCode(200)
  async decideApproval(
    @CurrentUser() ctx: UserContext,
    @Param('id') id: string,
    @Body() body: { decision: 'APPROVED' | 'REJECTED'; comment?: string },
  ) {
    return this.workflowService.decideApproval(ctx, id, body.decision, body.comment);
  }

  @Post('approvals/:id/delegate')
  @HttpCode(200)
  async delegateApproval(
    @CurrentUser() ctx: UserContext,
    @Param('id') id: string,
    @Body() body: { delegatedTo: string; until?: string },
  ) {
    return this.workflowService.delegateApproval(ctx, id, body.delegatedTo, body.until);
  }

  @Post('approvals/:id/override')
  @HttpCode(200)
  async overrideApproval(
    @CurrentUser() ctx: UserContext,
    @Param('id') id: string,
    @Body() body: { decision: 'APPROVED' | 'REJECTED'; comment?: string },
  ) {
    return this.workflowService.overrideApproval(ctx, id, body.decision, body.comment);
  }

  // --- PROCESS TEMPLATES ---

  @Get('process-templates')
  async listTemplates(@CurrentUser() ctx: UserContext, @Query('caseTypeId') caseTypeId?: string) {
    return this.workflowService.listTemplates(ctx, caseTypeId);
  }

  @Post('process-templates')
  async createTemplate(@CurrentUser() ctx: UserContext, @Body() body: any) {
    return this.workflowService.createTemplate(ctx, body);
  }

  // --- ESCALATIONS ---

  @Get('escalation-rules')
  async listRules(@CurrentUser() ctx: UserContext) {
    return this.workflowService.listEscalationRules(ctx);
  }

  @Put('escalation-rules/:id')
  async updateRule(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() body: any) {
    return this.workflowService.upsertEscalationRule(ctx, id, body);
  }

  @Post('escalation-rules')
  async createRule(@CurrentUser() ctx: UserContext, @Body() body: any) {
    return this.workflowService.upsertEscalationRule(ctx, undefined, body);
  }

  /** Idempotent sweep — safe to call repeatedly; fires each threshold once per case. */
  @Post('escalations/sweep')
  @HttpCode(200)
  async sweep(@CurrentUser() ctx: UserContext) {
    return this.workflowService.sweep(ctx);
  }
}
