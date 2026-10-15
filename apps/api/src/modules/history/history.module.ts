import { Global, Module } from '@nestjs/common';
import { HistoryController } from './history.controller';
import { HistoryService } from './history.service';

/** 历史记录服务全局可用，合同/项目模块通过它写入状态变化与节点流转 */
@Global()
@Module({
  controllers: [HistoryController],
  providers: [HistoryService],
  exports: [HistoryService],
})
export class HistoryModule {}
