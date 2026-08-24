import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';
import { RateLimitService } from './common/rate-limit.service';

// Prisma returns BigInt columns (e.g. slaPausedMs, sizeBytes); teach JSON to stringify them.
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

const ANON_PATHS =
  /^\/v1\/(auth\/(login|register|password\/forgot|resend-verification|verify-email)|public\/requests)$/;

/** §7.5: export endpoints carry their own tighter budget. */
function jwtSubject(authorization: string): string {
  const token = authorization.replace(/^Bearer\s+/i, '');
  const payload = token.split('.')[1];
  if (!payload) return 'anonymous';
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).sub ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function bootstrap() {
  // rawBody: HMAC webhook verification (payment/esign) needs the exact bytes.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors({
    origin: process.env.FRONTEND_URL?.split(',') ?? ['http://localhost:3000', 'http://localhost:3001'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'x-organization-id'],
  });

  // §7.5 budgets — wired at the Express layer so they run before routing.
  const rateLimit = app.get(RateLimitService);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const authorization = String(req.headers.authorization ?? '');
    const anonymous = !authorization;

    if (req.method === 'POST' && /\/export$/.test(req.path)) {
      const snap = rateLimit.hitExport(jwtSubject(authorization));
      res.setHeader('X-RateLimit-Limit', String(snap.limit));
      res.setHeader('X-RateLimit-Remaining', String(snap.remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(snap.reset / 1000)));
      if (snap.blocked) {
        res.setHeader('Retry-After', String(snap.retryAfterSec));
        return res.status(429).json({
          statusCode: 429,
          code: 'THROTTLED',
          message: 'Export rate limit exceeded. Retry shortly.',
        });
      }
    }

    if (req.method === 'POST' && anonymous && ANON_PATHS.test(req.path)) {
      const snap = rateLimit.hitAnon(req.ip ?? 'unknown');
      res.setHeader('X-RateLimit-Limit', String(snap.limit));
      res.setHeader('X-RateLimit-Remaining', String(snap.remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(snap.reset / 1000)));
      if (snap.blocked) {
        res.setHeader('Retry-After', String(snap.retryAfterSec));
        return res.status(429).json({
          statusCode: 429,
          code: 'THROTTLED',
          message: 'Too many requests from this address.',
        });
      }
    }
    next();
  });

  // Controllers already carry the /v1 prefix; no global prefix needed.
  await app.listen(process.env.PORT ?? 2020);
}
bootstrap();
