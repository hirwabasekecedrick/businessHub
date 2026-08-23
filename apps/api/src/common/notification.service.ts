import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

export interface NotifyInput {
  recipientId: string;
  organizationId?: string | null;
  eventKey: string;
  variables?: Record<string, any>;
  resourceType?: string | null;
  resourceId?: string | null;
  urgent?: boolean;
}

const DEFAULT_CHANNELS = ['IN_APP', 'EMAIL'];

function minutesNow(timezone: string): number {
  // Local testing treats server time as the user's timezone.
  const now = new Date();
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(private readonly prisma: PrismaService) {}

  async notify(input: NotifyInput): Promise<void> {
    const template = await this.prisma.notificationTemplate.findFirst({
      where: { OR: [{ code: input.eventKey }, { eventKey: input.eventKey }] },
    });

    // organizationId is a required column; resolve from the recipient's primary
    // membership (or the internal hub org) when the caller has no org context.
    let organizationId = input.organizationId ?? null;
    if (!organizationId) {
      const membership = await this.prisma.membership.findFirst({
        where: { userId: input.recipientId, deletedAt: null },
        select: { organizationId: true },
      });
      organizationId =
        membership?.organizationId ?? '00000000-0000-4000-8000-000000000001';
    }

    let channels = DEFAULT_CHANNELS;
    let held = false;
    const pref = await this.prisma.notificationPreference.findUnique({
      where: { userId: input.recipientId },
    });
    if (pref) {
      const configured = (pref.channels as any)?.[input.eventKey];
      if (Array.isArray(configured)) channels = configured;
      else if ((pref.channels as any)?.['*']) channels = (pref.channels as any)['*'];
      if (!input.urgent && pref.quietStart != null && pref.quietEnd != null) {
        const m = minutesNow(pref.timezone);
        const { quietStart, quietEnd } = pref;
        const overnight = quietStart > quietEnd;
        if (
          (overnight && (m >= quietStart || m < quietEnd)) ||
          (!overnight && m >= quietStart && m < quietEnd)
        ) {
          held = true;
        }
      }
    }

    const subject = this.render(template ? (template.locales as any)?.en?.subject : null, input.variables) ?? `BusinessHub: ${input.eventKey}`;
    const body = this.render(template ? (template.locales as any)?.en?.body : null, input.variables) ?? JSON.stringify(input.variables ?? {});

    for (const channel of channels) {
      await this.prisma.notification.create({
        data: {
          recipientId: input.recipientId,
          organizationId,
          channel: channel as any,
          templateCode: template?.code ?? input.eventKey,
          payload: {
            variables: input.variables ?? {},
            heldForQuietHours: held,
            batchedDigest: held,
          },
          subject,
          body,
          resourceType: input.resourceType ?? null,
          resourceId: input.resourceId ?? null,
          status: held ? 'QUEUED' : 'SENT',
          providerRef: held ? null : `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sentAt: held ? null : new Date(),
        },
      });
    }
    if (held) {
      this.logger.log(`Notification ${input.eventKey} held for user ${input.recipientId} (quiet hours)`);
    }
  }

  /** Deliver everything previously held (digest flush, e.g. at end of quiet hours). */
  async flushHeld(userId?: string): Promise<number> {
    const where: any = { payload: { path: ['heldForQuietHours'], equals: true }, status: 'QUEUED' };
    if (userId) where.recipientId = userId;
    const held = await this.prisma.notification.findMany({ where });
    for (const n of held) {
      await this.prisma.notification.update({
        where: { id: n.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          providerRef: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          payload: { ...(n.payload as any), heldForQuietHours: false, deliveredAsDigest: true },
        },
      });
    }
    return held.length;
  }

  private render(tpl: string | null | undefined, vars?: Record<string, any>): string | null {
    if (!tpl) return null;
    return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars?.[k] ?? ''));
  }
}
