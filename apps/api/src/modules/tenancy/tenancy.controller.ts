import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
} from '@nestjs/common';
import { TenancyService } from './tenancy.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { UserContext } from '../../common/abilities/case-ability.service';

@Controller('v1')
export class TenancyController {
  constructor(private readonly tenancyService: TenancyService) {}

  // --- ORGANIZATIONS ---

  @Get('organizations')
  async getOrganizations(@CurrentUser() ctx: UserContext) {
    return this.tenancyService.getOrganizations(ctx);
  }

  @Post('organizations')
  async createOrganization(@CurrentUser() ctx: UserContext, @Body() body: any) {
    return this.tenancyService.createOrganization(ctx, body);
  }

  @Get('organizations/:id')
  async getOrganization(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.tenancyService.getOrganization(ctx, id);
  }

  @Patch('organizations/:id')
  async updateOrganization(
    @CurrentUser() ctx: UserContext,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.tenancyService.updateOrganization(ctx, id, body);
  }

  @Post('organizations/:id/suspend')
  @HttpCode(200)
  async suspendOrganization(
    @CurrentUser() ctx: UserContext,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return this.tenancyService.suspendOrganization(ctx, id, body.reason);
  }

  @Post('organizations/:id/reactivate')
  @HttpCode(200)
  async reactivateOrganization(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.tenancyService.reactivateOrganization(ctx, id);
  }

  @Get('organizations/:id/members')
  async getMembers(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.tenancyService.getMembers(ctx, id);
  }

  @Post('organizations/:id/invitations')
  @HttpCode(201)
  async inviteUser(
    @CurrentUser() ctx: UserContext,
    @Param('id') id: string,
    @Body() body: { email: string; roleId: string },
  ) {
    return this.tenancyService.inviteUser(ctx, id, body.email, body.roleId);
  }

  @Post('invitations/:token/resend')
  @HttpCode(200)
  async resendInvitation(@CurrentUser() ctx: UserContext, @Param('token') token: string) {
    return this.tenancyService.resendInvitation(ctx, token);
  }

  @Post('invitations/:token/revoke')
  @HttpCode(200)
  async revokeInvitation(@CurrentUser() ctx: UserContext, @Param('token') token: string) {
    return this.tenancyService.revokeInvitation(ctx, token);
  }

  @Public()
  @Post('invitations/:token/accept')
  @HttpCode(200)
  async acceptInvitation(@Param('token') token: string, @Body() body: { password?: string }) {
    return this.tenancyService.acceptInvitation(token, body.password);
  }

  // --- MEMBERSHIPS ---

  @Delete('memberships/:id')
  async removeMember(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.tenancyService.removeMember(ctx, id);
  }

  @Patch('memberships/:id')
  async changeRole(
    @CurrentUser() ctx: UserContext,
    @Param('id') id: string,
    @Body() body: { roleId: string },
  ) {
    return this.tenancyService.changeRole(ctx, id, body.roleId);
  }

  // --- USERS ---

  @Get('users')
  async getUsers(@CurrentUser() ctx: UserContext) {
    return this.tenancyService.getUsers(ctx);
  }

  @Get('users/:id')
  async getUser(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.tenancyService.getUser(ctx, id);
  }

  @Patch('users/:id')
  async updateUser(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() body: any) {
    return this.tenancyService.updateUser(ctx, id, body);
  }

  @Post('users/:id/deactivate')
  @HttpCode(200)
  async deactivateUser(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.tenancyService.deactivateUser(ctx, id);
  }

  // --- ROLES ---

  @Get('roles')
  async getRoles(@CurrentUser() ctx: UserContext) {
    return this.tenancyService.getRoles(ctx);
  }

  @Post('roles')
  async createRole(@CurrentUser() ctx: UserContext, @Body() body: any) {
    return this.tenancyService.createRole(ctx, body);
  }

  @Patch('roles/:id')
  async updateRole(@CurrentUser() ctx: UserContext, @Param('id') id: string, @Body() body: any) {
    return this.tenancyService.updateRole(ctx, id, body);
  }
}
