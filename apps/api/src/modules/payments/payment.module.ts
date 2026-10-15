import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { ContractStatusModule } from '../contracts/contract-status.module';

// exports PaymentService：导出模块（PRD 4.12）需要复用它的 buildExportWhere 做数据范围过滤
@Module({ imports: [AuthModule, ContractStatusModule], controllers: [PaymentController], providers: [PaymentService], exports: [PaymentService] })
export class PaymentModule {}
