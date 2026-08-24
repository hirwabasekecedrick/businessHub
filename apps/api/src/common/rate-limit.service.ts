import { Injectable, HttpException, HttpStatus } from '@nestjs/common';

/**
 * §7.5 — in-memory sliding-window rate limiting.
 *
 *   - Anonymous: 30 req/min per IP on public auth/intake endpoints
 *   - Sign-in:   10 failed attempts per 15 min per account
 *   - Exports:   10 req/min per user on export endpoints
 *
 * Limits are environment-tunable so local test runs can raise them without
 * weakening the production defaults.
 */
@Injectable()
export class RateLimitService {
  private anonHits = new Map<string, number[]>();
  private exportHits = new Map<string, number[]>();
  private loginFailures = new Map<string, number[]>();

  get anonPerMin(): number {
    return Number(process.env.RATE_LIMIT_ANON_PER_MIN ?? 30);
  }

  get exportsPerMin(): number {
    return Number(process.env.RATE_LIMIT_EXPORT_PER_MIN ?? 10);
  }

  get loginMaxFailures(): number {
    return Number(process.env.RATE_LIMIT_LOGIN_FAILURES ?? 10);
  }

  /** Sliding-window tick. Returns the snapshot and whether the caller is over budget. */
  private hit(bucket: Map<string, number[]>, key: string, windowMs: number, max: number) {
    const now = Date.now();
    const hits = (bucket.get(key) ?? []).filter((t) => t > now - windowMs);
    hits.push(now);
    bucket.set(key, hits);
    const oldest = hits[0];
    const blocked = hits.length > max;
    return {
      limit: max,
      remaining: Math.max(0, max - hits.length),
      reset: blocked ? oldest + windowMs : now + windowMs,
      retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
      blocked,
    };
  }

  hitAnon(ip: string) {
    return this.hit(this.anonHits, ip, 60_000, this.anonPerMin);
  }

  hitExport(userKey: string) {
    return this.hit(this.exportHits, userKey, 60_000, this.exportsPerMin);
  }

  /** Sign-in throttle counts FAILURES only — successful authentication resets the budget. */
  assertLoginAllowed(email: string): void {
    const key = String(email ?? '').toLowerCase();
    if (!key) return;
    const now = Date.now();
    const windowStart = now - 15 * 60 * 1000;
    const failures = (this.loginFailures.get(key) ?? []).filter((t) => t > windowStart);
    this.loginFailures.set(key, failures);
    if (failures.length >= this.loginMaxFailures) {
      throw new HttpException(
        {
          code: 'THROTTLED',
          message: `Too many failed sign-in attempts. Try again in ${Math.ceil((failures[0] + 15 * 60_000 - now) / 1000)}s.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  recordLoginFailure(email: string): void {
    const key = String(email ?? '').toLowerCase();
    if (!key) return;
    const failures = (this.loginFailures.get(key) ?? []).filter(
      (t) => t > Date.now() - 15 * 60_000,
    );
    failures.push(Date.now());
    this.loginFailures.set(key, failures);
  }

  clearLoginFailures(email: string): void {
    this.loginFailures.delete(String(email ?? '').toLowerCase());
  }
}
