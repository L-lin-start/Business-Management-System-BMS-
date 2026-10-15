import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './infrastructure/database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { AdminModule } from './modules/admin/admin.module';
import { HealthModule } from './modules/health/health.module';
import { AuditModule } from './infrastructure/audit/audit.module';
import { DocumentNumberModule } from './infrastructure/document-number/document-number.module';
import { CustomFieldsModule } from './infrastructure/custom-fields/custom-fields.module';
import { CustomerModule } from './modules/customers/customer.module';
import { ContractModule } from './modules/contracts/contract.module';
import { ContractStatusModule } from './modules/contracts/contract-status.module';
import { ProjectModule } from './modules/projects/project.module';
import { PaymentModule } from './modules/payments/payment.module';
import { CostModule } from './modules/costs/cost.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { OptionsModule } from './modules/options/options.module';
import { HistoryModule } from './modules/history/history.module';
import { WorkflowModule } from './modules/workflows/workflow.module';
import { ReminderModule } from './modules/reminders/reminder.module';
import { FileModule } from './infrastructure/files/file.module';
import { ExportModule } from './infrastructure/export/export.module';
import { DeleteModule } from './infrastructure/delete/delete.module';
import { RecordModule } from './modules/records/record.module';
import { ProjectAccessScopeModule } from './infrastructure/project-access/project-access-scope.module';
import { FeedbackModule } from './modules/feedback/feedback.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule, ProjectAccessScopeModule, AuditModule, DocumentNumberModule, CustomFieldsModule, HistoryModule, ContractStatusModule, WorkflowModule, ReminderModule, FileModule, ExportModule, DeleteModule, AuthModule, AdminModule, CustomerModule, ContractModule, ProjectModule, PaymentModule, CostModule, DashboardModule, OptionsModule, RecordModule, FeedbackModule, HealthModule],
})
export class AppModule {}

