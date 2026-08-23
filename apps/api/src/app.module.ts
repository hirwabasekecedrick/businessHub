import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CasesModule } from './modules/cases/cases.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { IdentityModule } from './modules/identity/identity.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { CrmModule } from './modules/crm/crm.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { FinanceModule } from './modules/finance/finance.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReportsModule } from './modules/reports/reports.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuthGuard } from './common/guards/auth.guard';
import { PrismaModule } from './common/prisma.service';
import { CommonModule } from './common/common.module';

@Module({
  imports: [
    PrismaModule,
    CommonModule,
    CasesModule,
    WorkflowModule,
    IdentityModule,
    TenancyModule,
    CrmModule,
    DocumentsModule,
    FinanceModule,
    NotificationsModule,
    ReportsModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
})
export class AppModule {}
