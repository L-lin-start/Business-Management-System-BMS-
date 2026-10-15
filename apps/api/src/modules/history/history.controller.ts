import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { HistoryService, parseResourceType } from './history.service';

/**
 * 状态变化历史查询。合同与项目共用一套接口，按 resourceType 区分。
 * 权限沿用对应业务模块的读取权限（详情页本来就是能看到详情的人才能看到历史）。
 */
@Controller('api/status-history')
@UseGuards(AccessTokenGuard)
export class HistoryController {
  constructor(@Inject(HistoryService) private readonly historyService: HistoryService) {}

  @Get()
  list(@Query('resourceType') resourceType: string, @Query('resourceId') resourceId: string) {
    return this.historyService.listStatusHistory(parseResourceType(resourceType ?? ''), resourceId ?? '');
  }
}
