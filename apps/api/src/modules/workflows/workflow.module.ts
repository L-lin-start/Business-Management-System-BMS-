import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TransitionController } from './transition.controller';
import { NodeAssigneeService } from './node-assignee.service';
import { TransitionService } from './transition.service';
import { WorkflowAdminController } from './workflow-admin.controller';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';
import { ContractStatusModule } from '../contracts/contract-status.module';

/**
 * 流程与节点推进。
 * WorkflowService 导出给项目模块使用（创建项目时按项目类型绑定已发布版本）。
 */
@Global()
@Module({
  imports: [AuthModule, ContractStatusModule],
  controllers: [WorkflowController, WorkflowAdminController, TransitionController],
  providers: [WorkflowService, TransitionService, NodeAssigneeService],
  exports: [WorkflowService, TransitionService, NodeAssigneeService],
})
export class WorkflowModule {}

