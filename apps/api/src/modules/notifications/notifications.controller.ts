import { Controller, Get, Post, Put, Param, Body, Query, HttpCode, Res, ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';
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
      data: { readAt: new Date(), status: 'READ' },
    });
    const n = await this.prisma.notification.findUnique({ where: { id } });
    return { message: 'Marked as read', notification: n };
  }

  /** FR-7.7: mark the whole feed read. */
  @Post('notifications/read-all')
  @HttpCode(200)
  async markAllRead(@CurrentUser() ctx: UserContext) {
    const res = await this.prisma.notification.updateMany({
      where: { recipientId: ctx.id, readAt: null },
      data: { readAt: new Date(), status: 'READ' },
    });
    return { message: 'Feed marked as read', updated: res.count };
  }

  /**
   * FR-7.5 / FR-7.6: drain the delivery outbox — retries failed sends whose
   * exponential backoff has elapsed. Idempotent; safe to call repeatedly.
   */
  @Post('notifications/delivery/run')
  @HttpCode(200)
  async runDelivery(@CurrentUser() ctx: UserContext) {
    if (!ctx.permissions?.includes('*') && !ctx.permissions?.includes('notification.template.manage')) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', required: 'notification.template.manage' });
    }
    return this.notifications.retryFailed();
  }

  /**
   * FR-7.7 / US-7.1: server-sent events for the live badge and toasts.
   * Emits `unread` count changes and `notification` events for fresh rows.
   */
  @Get('notifications/stream')
  async stream(@CurrentUser() ctx: UserContext, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`event: hello\ndata: {"userId":"${ctx.id}"}\n\n`);

    let lastUnread = -1;
    let lastCreated = new Date(0);
    const tick = async () => {
      try {
        if (res.writableEnded || res.closed) return;
        const [unread, latest] = await Promise.all([
          this.prisma.notification.count({ where: { recipientId: ctx.id, readAt: null } }),
          this.prisma.notification.findFirst({
            where: { recipientId: ctx.id, createdAt: { gt: lastCreated } },
            orderBy: { createdAt: 'desc' },
          }),
        ]);
        if (latest) {
          lastCreated = latest.createdAt;
          // Only announce rows created after the stream opened.
          if (lastUnread !== -1 && Date.now() - latest.createdAt.getTime() < 15000) {
            res.write(
              `event: notification\ndata: ${JSON.stringify({
                id: latest.id,
                templateCode: latest.templateCode,
                subject: latest.subject,
                body: latest.body,
                resourceType: latest.resourceType,
                resourceId: latest.resourceId,
                createdAt: latest.createdAt,
              })}\n\n`,
            );
          }
        }
        if (unread !== lastUnread) {
          lastUnread = unread;
          res.write(`event: unread\ndata: {"count":${unread}}\n\n`);
        }
      } catch {
        /* transient DB hiccup — keep the stream open */
      }
    };

    await tick();
    const interval = setInterval(tick, 5000);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.closed) res.write(': ping\n\n');
    }, 20000);

    const close = () => {
      clearInterval(interval);
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    };
    res.on('close', close);
    res.req.on('close', close);
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
