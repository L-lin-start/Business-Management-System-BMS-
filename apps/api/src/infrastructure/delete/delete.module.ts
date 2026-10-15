import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../../modules/auth/auth.module';
import { ContractModule } from '../../modules/contracts/contract.module';
import { ProjectModule } from '../../modules/projects/project.module';
import { CustomerModule } from '../../modules/customers/customer.module';
import { PaymentModule } from '../../modules/payments/payment.module';
import { CostModule } from '../../modules/costs/cost.module';
import { AdminModule } from '../../modules/admin/admin.module';
import { DeletedRecordsController } from './deleted-records.controller';

/**
 * 已删除数据与恢复（PRD 7.1 / 7.2）。
 *
 * 依赖各业务模块导出的 Service —— 恢复合同/项目时必须调用它们自己的 `restore()`，
 * 由那边负责按 `deleteReason` 回滚级联作废的子记录。
 * 用户账号同理走 `AdminService.restoreUser()`（它决定"不还原角色与部门"）。
 */
@Module({
  imports: [DatabaseModule, AuditModule, AuthModule, ContractModule, ProjectModule, CustomerModule, PaymentModule, CostModule, AdminModule],
  controllers: [DeletedRecordsController],
})
export class DeleteModule {}
