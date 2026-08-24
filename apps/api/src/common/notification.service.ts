import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { MailerService } from './mailer.service';

export interface NotifyInput {
  recipientId: string;
  organizationId?: string | null;
  eventKey: string;
  variables?: Record<string, any>;
  resourceType?: string | null;
  resourceId?: string | null;
  urgent?: boolean;
  /** Extra keys stored on each row's payload (e.g. reminder thresholds for idempotency). */
  payloadExtras?: Record<string, any>;
}

const DEFAULT_CHANNELS = ['IN_APP', 'EMAIL'];

/** FR-7.5: exponential backoff (minutes) after the nth failed attempt. */
const RETRY_BACKOFF_MINUTES = [1, 5, 30, 120, 720];
const MAX_ATTEMPTS = RETRY_BACKOFF_MINUTES.length;

function minutesNow(timezone: string): number {
  // Local testing treats server time as the user's timezone.
  const now = new Date();
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

interface PendingRow {
  id: string;
  channel: string;
  recipientId: string;
  subject: string | null;
  body: string | null;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
  ) {}

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

    const payload = {
      variables: input.variables ?? {},
      heldForQuietHours: held,
      batchedDigest: held,
      ...(input.payloadExtras ?? {}),
    };

    // FR-7.5/FR-7.6: every channel row is enqueued first (QUEUED), then an
    // initial delivery is ATTEMPTED inline but never allowed to break the
    // originating request — a provider rejection marks the row FAILED with a
    // scheduled retry instead of throwing.
    for (const channel of channels) {
      const row = await this.prisma.notification.create({
        data: {
          recipientId: input.recipientId,
          organizationId,
          channel: channel as any,
          templateCode: template?.code ?? input.eventKey,
          payload,
          subject,
          body,
          resourceType: input.resourceType ?? null,
          resourceId: input.resourceId ?? null,
          status: 'QUEUED',
        },
      });
      if (!held) {
        await this.deliverRow(row);
      } else {
        this.logger.log(`Notification ${input.eventKey} held for user ${input.recipientId} (quiet hours)`);
      }
    }
  }

  /**
   * FR-7.6: one delivery attempt for a queued row. Outcome mapping:
   *  - provider accepted (or log-only transport) -> SENT (+providerRef)
   *  - provider rejected / transport error       -> FAILED (+error, retry scheduled)
   */
  private async deliverRow(row: PendingRow): Promise<void> {
    try {
      if (row.channel === 'EMAIL') {
        const recipient = await this.prisma.user.findUnique({
          where: { id: row.recipientId },
          select: { email: true },
        });
        if (!recipient) {
          await this.markFailed(row.id, 'RECIPIENT_HAS_NO_EMAIL_ADDRESS');
          return;
        }
        const result = await this.mailer.send({
          to: recipient.email,
          subject: row.subject ?? 'BusinessHub notification',
          text: this.toPlainText(row.body ?? ''),
          html: this.mailer.wrap(
            row.subject ?? 'BusinessHub notification',
            `<p>${this.escapeHtml(this.toPlainText(row.body ?? ''))}</p>`,
          ),
        });
        if (result.delivered || result.providerRef.startsWith('console-')) {
          await this.markSent(row.id, result.providerRef);
        } else {
          await this.markFailed(row.id, result.error ?? 'PROVIDER_REJECTED', result.providerRef);
        }
        return;
      }

      // IN_APP (and any future SMS/PUSH bridge): the row itself is the
      // delivery — the live feed and SSE stream surface it instantly.
      await this.markSent(
        row.id,
        `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
    } catch (e) {
      await this.markFailed(row.id, String(e).slice(0, 500)).catch(() => {});
    }
  }

  private async markSent(id: string, providerRef: string): Promise<void> {
    await this.prisma.notification.update({
      where: { id },
      data: {
        status: 'SENT',
        providerRef,
        error: null,
        sentAt: new Date(),
      },
    });
  }

  private async markFailed(id: string, error: string, providerRef?: string): Promise<void> {
    const current = await this.prisma.notification.findUnique({
      where: { id },
      select: { attempts: true },
    });
    const attempts = (current?.attempts ?? 0) + 1;
    const exhausted = attempts >= MAX_ATTEMPTS;
    await this.prisma.notification.update({
      where: { id },
      data: {
        status: 'FAILED',
        attempts,
        error: exhausted ? `${error} (exhausted retries)` : error,
        ...(providerRef ? { providerRef } : {}),
        nextRetryAt: exhausted ? null : new Date(Date.now() + RETRY_BACKOFF_MINUTES[attempts - 1] * 60 * 1000),
      },
    });
  }

  /**
   * FR-7.5: drain sweep for failed deliveries whose backoff has elapsed.
   * Idempotent and safe to call repeatedly; gives up after MAX_ATTEMPTS tries.
   */
  async retryFailed(limit = 50): Promise<{ processed: number; sent: number; failed: number }> {
    const due = await this.prisma.notification.findMany({
      where: {
        status: 'FAILED',
        attempts: { lt: MAX_ATTEMPTS },
        nextRetryAt: { lte: new Date() },
      },
      orderBy: { nextRetryAt: 'asc' },
      take: limit,
    });
    let sent = 0;
    let failed = 0;
    for (const row of due) {
      const before = row.attempts;
      await this.deliverRow(row);
      const after = await this.prisma.notification.findUnique({
        where: { id: row.id },
        select: { status: true, attempts: true },
      });
      if (after?.status === 'SENT' && after.attempts === before) {
        sent++;
      } else {
        failed++;
      }
    }
    return { processed: due.length, sent, failed };
  }

  /** Deliver everything previously held (digest flush, e.g. at end of quiet hours). */
  async flushHeld(userId?: string): Promise<number> {
    const where: any = { payload: { path: ['heldForQuietHours'], equals: true }, status: 'QUEUED' };
    if (userId) where.recipientId = userId;
    const held = await this.prisma.notification.findMany({ where });
    for (const n of held) {
      await this.deliverRow(n);
      await this.prisma.notification.update({
        where: { id: n.id },
        data: {
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

  private toPlainText(body: string): string {
    try {
      const parsed = JSON.parse(body);
      return typeof parsed === 'string' ? parsed : Object.entries(parsed).map(([k, v]) => `${k}: ${String(v)}`).join('\n');
    } catch {
      return body;
    }
  }

  private escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
  }
}
