import { Module } from '@nestjs/common';
import { AuditModule } from '../../infrastructure/audit/audit.module';
import { CustomFieldsModule } from '../../infrastructure/custom-fields/custom-fields.module';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { OptionsModule } from '../options/options.module';
import { RecordController } from './record.controller';
import { RecordScopeService } from './record-scope.service';
import { ActionRecordService, FilingResultService, MailDeliveryService, OfficialDocumentService } from './record.service';

/**
 * 附属业务数据模块（PRD 2.2）：官文管理、邮件送达登记、动作记录、申报结果记录。
 *
 * 四类记录共用 `RecordScopeService` 做归属与数据范围判定，
 * 避免像早期那样把「项目可见范围」在多个模块里各抄一份、改一处漏一处。
 */
@Module({
  imports: [DatabaseModule, AuditModule, CustomFieldsModule, OptionsModule],
  controllers: [RecordController],
  providers: [RecordScopeService, OfficialDocumentService, MailDeliveryService, ActionRecordService, FilingResultService],
  exports: [RecordScopeService, OfficialDocumentService, MailDeliveryService, ActionRecordService, FilingResultService],
})
export class RecordModule {}
