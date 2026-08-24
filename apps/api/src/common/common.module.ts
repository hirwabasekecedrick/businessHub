import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuditService } from './audit.service';
import { NotificationService } from './notification.service';
import { MailerService } from './mailer.service';
import { RateLimitService } from './rate-limit.service';
import { jwtModuleOptionsFactory } from './jwt.config';

@Global()
@Module({
  imports: [JwtModule.registerAsync({ useFactory: jwtModuleOptionsFactory })],
  providers: [AuditService, NotificationService, MailerService, RateLimitService],
  exports: [AuditService, NotificationService, MailerService, RateLimitService, JwtModule],
})
export class CommonModule {}
