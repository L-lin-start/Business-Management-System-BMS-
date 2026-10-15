import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CostController } from './cost.controller';
import { CostService } from './cost.service';

// exports CostService：导出模块（PRD 4.12）复用它的 buildExportWhere 做数据范围过滤
@Module({ imports: [AuthModule], controllers: [CostController], providers: [CostService], exports: [CostService] })
export class CostModule {}
