import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuditService } from './audit.service';
import { NotificationService } from './notification.service';
import { jwtModuleOptionsFactory } from './jwt.config';

@Global()
@Module({
  imports: [JwtModule.registerAsync({ useFactory: jwtModuleOptionsFactory })],
  providers: [AuditService, NotificationService],
  exports: [AuditService, NotificationService, JwtModule],
})
export class CommonModule {}
