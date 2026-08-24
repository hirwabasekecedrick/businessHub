import { Injectable, Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailResult {
  delivered: boolean;
  providerRef: string;
  error?: string;
}

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  /** Resend HTTP API key — takes precedence over raw SMTP when present. */
  private resendKey: string | null = null;
  private transporter: Transporter | null = null;
  /** Circuit breaker: after repeated consecutive failures, fail fast for a cooldown. */
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private static readonly BREAKER_THRESHOLD = 5;
  private static readonly BREAKER_COOLDOWN_MS = 10 * 60 * 1000;

  private static readonly RESEND_API_URL = 'https://api.resend.com/emails';

  constructor() {
    if (process.env.MAIL_DISABLED === '1') {
      this.logger.warn('Mail sending disabled via MAIL_DISABLED=1 — emails are logged to the console only');
      return;
    }

    this.resendKey = process.env.RESEND_API_KEY ?? null;
    if (this.resendKey) {
      this.logger.log('Resend transport ready (HTTP API)');
      return;
    }

    // Fallback: raw SMTP, used only when no Resend API key is configured.
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (host && user && pass) {
      const port = Number(process.env.SMTP_PORT ?? '465');
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: (process.env.SMTP_SECURE ?? String(port === 465)) === 'true',
        auth: { user, pass },
        // Never let a dead provider hang an API request: fail fast into the
        // FR-7.6 retry path / circuit breaker instead.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });
      this.logger.log(`SMTP transport ready via ${host}:${port} as ${user}`);
    } else {
      this.logger.warn('No mail provider configured (RESEND_API_KEY or SMTP_*) — emails are logged to the console only');
    }
  }

  get configured(): boolean {
    return this.resendKey !== null || this.transporter !== null;
  }

  get from(): string {
    return (
      process.env.MAIL_FROM ??
      process.env.SMTP_USER ??
      'BusinessHub <no-reply@businesshub.local>'
    );
  }

  /**
   * Sends an email via Resend (preferred) or raw SMTP (fallback), falling back
   * to a console log when neither provider is configured. Never throws.
   * Recipients whose address starts with "fail." deterministically simulate a
   * provider rejection (delivery-retry test hook).
   */
  async send(mail: MailInput): Promise<MailResult> {
    const ref = `mail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (/^fail\./i.test(mail.to)) {
      return {
        delivered: false,
        providerRef: `failed-sim-${ref}`,
        error: 'SIMULATED_PROVIDER_FAILURE',
      };
    }
    if (!this.resendKey && !this.transporter) {
      this.logger.log(
        `[console mail] to=${mail.to} subject="${mail.subject}"\n${mail.text}`,
      );
      return { delivered: false, providerRef: `console-${ref}` };
    }
    if (Date.now() < this.circuitOpenUntil) {
      return {
        delivered: false,
        providerRef: `circuit-${ref}`,
        error: 'PROVIDER_CIRCUIT_OPEN',
      };
    }
    try {
      const providerRef = this.resendKey
        ? await this.sendViaResend(mail, ref)
        : await this.sendViaSmtp(mail, ref);
      this.consecutiveFailures = 0;
      return { delivered: true, providerRef };
    } catch (err) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= MailerService.BREAKER_THRESHOLD) {
        this.circuitOpenUntil = Date.now() + MailerService.BREAKER_COOLDOWN_MS;
        this.logger.error(
          `Mail provider circuit OPEN for ${MailerService.BREAKER_COOLDOWN_MS / 1000}s after ${this.consecutiveFailures} consecutive failures`,
        );
      }
      this.logger.error(`Mail send failed for ${mail.to}: ${String(err)}`);
      return { delivered: false, providerRef: `failed-${ref}`, error: String(err).slice(0, 500) };
    }
  }

  /** Sends via the Resend HTTP API. Throws on non-2xx / network failure. */
  private async sendViaResend(mail: MailInput, ref: string): Promise<string> {
    const res = await fetch(MailerService.RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
      // Never let a dead provider hang an API request: fail fast into the
      // FR-7.6 retry path / circuit breaker instead.
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      name?: string;
    };
    if (!res.ok) {
      throw new Error(`Resend API ${res.status}: ${body.message ?? JSON.stringify(body)}`);
    }
    return body.id ?? ref;
  }

  /** Sends via raw SMTP (nodemailer). Throws on failure. */
  private async sendViaSmtp(mail: MailInput, ref: string): Promise<string> {
    const info = await this.transporter!.sendMail({ from: this.from, ...mail });
    return info.messageId ?? ref;
  }

  /** Branded HTML wrapper for transactional emails. */
  wrap(title: string, bodyHtml: string, ctaText?: string, ctaUrl?: string): string {
    const logoUrl = `${(process.env.FRONTEND_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/logo_no_bg.png`;
    const cta =
      ctaText && ctaUrl
        ? `<p style="margin:28px 0 8px"><a href="${ctaUrl}" style="display:inline-block;background:#1b2cc1;color:#ffffff;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;padding:12px 24px;border-radius:8px;text-decoration:none">${ctaText}</a></p>`
        : '';
    return `<div style="background:#f1f5f9;padding:32px">
  <div style="max-width:520px;margin:auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
    <div style="background:#ffffff;padding:24px 28px;border-bottom:1px solid #e2e8f0">
      <img src="${logoUrl}" alt="BusinessHub" height="36" style="height:36px;width:auto;display:block;border:0" />
    </div>
    <div style="padding:28px;font-family:Arial,sans-serif;color:#091540;line-height:1.6">
      <h2 style="margin:0 0 16px;font-size:18px">${title}</h2>
      ${bodyHtml}
      ${cta}
    </div>
    <div style="padding:16px 28px;background:#f8fafc;color:#64748b;font-size:12px;font-family:Arial,sans-serif">
      This is an automated message from BusinessHub.
    </div>
  </div>
</div>`;
  }
}
