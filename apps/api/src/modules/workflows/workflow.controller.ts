import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { AccessTokenGuard } from '../auth/access-token.guard';
import { WorkflowService } from './workflow.service';

/**
 * 系统 A 读取流程定义：按项目类型返回当前已发布的流程节点，
 * 用于项目详情展示完整流程与「当前节点 / 下一步」。
 */
@Controller('api/workflows')
@UseGuards(AccessTokenGuard)
export class WorkflowController {
  constructor(@Inject(WorkflowService) private readonly workflowService: WorkflowService) {}

  @Get('published')
  published(@Query('projectType') projectType?: string) {
    return this.workflowService.listPublishedNodes(projectType);
  }
}
