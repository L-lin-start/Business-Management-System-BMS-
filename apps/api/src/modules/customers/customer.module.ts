import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CustomerController } from './customer.controller';
import { CustomerService } from './customer.service';

// exports CustomerService：导出模块（PRD 4.12）复用它的 buildExportWhere 做数据范围过滤
@Module({
  imports: [AuthModule],
  controllers: [CustomerController],
  providers: [CustomerService],
  exports: [CustomerService],
})
export class CustomerModule {}
