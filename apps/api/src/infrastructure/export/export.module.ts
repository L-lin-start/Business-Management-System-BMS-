import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../../modules/auth/auth.module';
import { ContractModule } from '../../modules/contracts/contract.module';
import { ProjectModule } from '../../modules/projects/project.module';
import { PaymentModule } from '../../modules/payments/payment.module';
import { CostModule } from '../../modules/costs/cost.module';
import { CustomerModule } from '../../modules/customers/customer.module';
import { ExportConfigService } from './export-definitions';
import { ExportService } from './export.service';
import { ExportController } from './export.controller';
import { ExportConfigAdminController } from './export-config.controller';

/**
 * 导出模块（PRD 4.12 / 5.10）。
 *
 * 依赖各业务模块导出的 Service —— 导出的**过滤条件**必须复用它们各自的
 * `buildExportWhere()`，而那个方法内部用的就是该模块列表同一套数据范围判定。
 * 若这里自己查库拼条件，就会出现"列表看不到、导出却能看到"的越权。
 */
@Module({
  imports: [DatabaseModule, AuthModule, ContractModule, ProjectModule, PaymentModule, CostModule, CustomerModule],
  controllers: [ExportController, ExportConfigAdminController],
  providers: [ExportConfigService, ExportService],
  exports: [ExportService],
})
export class ExportModule {}
