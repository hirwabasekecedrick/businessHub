import { Controller, Get, Post, Put, Param, Body, Query, HttpCode } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { NotificationService } from '../../common/notification.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { UserContext } from '../../common/abilities/case-ability.service';

@Controller('v1')
export class NotificationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  @Get('notifications')
  async feed(@CurrentUser() ctx: UserContext, @Query('unread') unread?: string) {
    return this.prisma.notification.findMany({
      where: {
        recipientId: ctx.id,
        ...(unread === 'true' ? { readAt: null } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Post('notifications/:id/read')
  @HttpCode(200)
  async markRead(@CurrentUser() ctx: UserContext, @Param('id') id: string) {
    await this.prisma.notification.updateMany({
      where: { id, recipientId: ctx.id },
      data: { readAt: new Date() },
    });
    const n = await this.prisma.notification.findUnique({ where: { id } });
    return { message: 'Marked as read', notification: n };
  }

  /** US-7.2 / FR-7.1: quiet hours hold messages; the digest flush delivers them after. */
  @Post('notifications/flush-held')
  @HttpCode(200)
  async flushHeld(@CurrentUser() ctx: UserContext) {
    return this.notifications.flushHeld(ctx.id);
  }

  @Get('notification-preferences')
  async getPreferences(@CurrentUser() ctx: UserContext) {
    return (
      (await this.prisma.notificationPreference.findUnique({ where: { userId: ctx.id } })) ?? {
        userId: ctx.id,
        channels: {},
        quietStart: null,
        quietEnd: null,
        timezone: 'UTC',
      }
    );
  }

  @Put('notification-preferences')
  async setPreferences(@CurrentUser() ctx: UserContext, @Body() body: any) {
    return this.prisma.notificationPreference.upsert({
      where: { userId: ctx.id },
      update: {
        channels: body.channels,
        quietStart: body.quietStart,
        quietEnd: body.quietEnd,
        timezone: body.timezone,
      },
      create: {
        userId: ctx.id,
        channels: body.channels ?? {},
        quietStart: body.quietStart ?? null,
        quietEnd: body.quietEnd ?? null,
        timezone: body.timezone ?? 'UTC',
      },
    });
  }
}
