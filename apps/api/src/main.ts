import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

// Prisma returns BigInt columns (e.g. slaPausedMs, sizeBytes); teach JSON to stringify them.
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

async function bootstrap() {
  // rawBody: HMAC webhook verification (payment/esign) needs the exact bytes.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableCors({
    origin: process.env.FRONTEND_URL?.split(',') ?? ['http://localhost:3000', 'http://localhost:3001'],
    credentials: true,
  });
  // Controllers already carry the /v1 prefix; no global prefix needed.
  await app.listen(process.env.PORT ?? 2020);
}
bootstrap();
