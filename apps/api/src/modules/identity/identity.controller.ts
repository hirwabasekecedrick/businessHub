import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  HttpCode,
} from '@nestjs/common';
import { IdentityService } from './identity.service';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { UserContext } from '../../common/abilities/case-ability.service';

@Controller('v1/auth')
export class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

  @Public()
  @Post('register')
  async register(@Body() body: any) {
    return this.identityService.register(body);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(@Body() body: { token: string }, @Req() req: any) {
    return this.identityService.verifyEmail(body.token, req.ip, req.headers['user-agent']);
  }

  /** US-1.1: unverified users can request a fresh verification email from the sign-in error state. */
  @Public()
  @Post('resend-verification')
  @HttpCode(200)
  async resendVerification(@Body() body: { email: string }) {
    return this.identityService.resendVerification(body.email);
  }

  /** FR-1.4: forgotten password — step 1 issues the single-use link, step 2 applies the new password. */
  @Public()
  @Post('password/forgot')
  @HttpCode(200)
  async forgotPassword(@Body() body: { email: string }) {
    return this.identityService.forgotPassword(body.email);
  }

  /** FR-1.4: applying the new password revokes every existing session. */
  @Public()
  @Post('password/reset')
  @HttpCode(200)
  async resetPassword(@Body() body: { token: string; password: string }, @Req() req: any) {
    return this.identityService.resetPassword(body.token, body.password, req.ip, req.headers['user-agent']);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: any, @Req() req: any) {
    return this.identityService.login(
      body.email,
      body.password,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  async verifyMfa(
    @Body() body: { challengeId: string; code?: string; recoveryCode?: string },
    @Req() req: any,
  ) {
    return this.identityService.verifyMfa(
      body.challengeId,
      body.code ?? body.recoveryCode ?? '',
      req.ip,
      req.headers['user-agent'],
    );
  }

  /** US-1.2 forced enrolment (sign-in challenge, not yet authenticated). */
  @Public()
  @Post('mfa/enrol/challenge')
  @HttpCode(200)
  async enrolForChallenge(@Body() body: { challengeId: string }) {
    return this.identityService.enrolForChallenge(body.challengeId);
  }

  /** Completes forced enrolment and returns the first real session. */
  @Public()
  @Post('mfa/confirm/challenge')
  @HttpCode(200)
  async confirmEnrolmentForChallenge(
    @Body() body: { challengeId: string; code: string },
    @Req() req: any,
  ) {
    return this.identityService.confirmEnrolmentForChallenge(
      body.challengeId,
      body.code,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: { refreshToken: string }, @Req() req: any) {
    return this.identityService.refresh(
      body.refreshToken,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @Post('logout')
  @HttpCode(200)
  async logout(
    @CurrentUser() ctx: UserContext,
    @Req() req: any,
    @Body() body: { refreshToken: string },
  ) {
    return this.identityService.logout(
      body.refreshToken,
      ctx,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @Get('me')
  async getMe(@CurrentUser() ctx: UserContext) {
    return this.identityService.getMe(ctx);
  }

  @Get('sessions')
  async getSessions(@CurrentUser() ctx: UserContext) {
    return this.identityService.getSessions(ctx);
  }

  @Delete('sessions/:id')
  async revokeSession(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    return this.identityService.revokeSession(ctx, id);
  }

  @Post('mfa/enrol')
  @HttpCode(200)
  async enrolMfa(@CurrentUser() ctx: UserContext) {
    return this.identityService.enrolMfa(ctx);
  }

  @Post('mfa/confirm')
  @HttpCode(200)
  async confirmMfa(@CurrentUser() ctx: UserContext, @Body() body: { code: string }) {
    return this.identityService.confirmMfa(ctx, body.code);
  }

  @Delete('mfa')
  async disableMfa(@CurrentUser() ctx: UserContext) {
    return this.identityService.disableMfa(ctx);
  }
}
