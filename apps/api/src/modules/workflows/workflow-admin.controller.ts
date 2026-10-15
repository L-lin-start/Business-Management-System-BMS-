import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { PermissionGuard } from '../auth/permission.guard';
import { WorkflowService } from './workflow.service';
import { CreateWorkflowTemplateDto, CreateWorkflowVersionDto, UpdateWorkflowTemplateDto, WorkflowNodeDto } from './dto/workflow.dto';

/** 系统 B：流程模板、版本与节点维护。与其他管理接口一致，受 system.admin.access 控制。 */
@Controller('api/admin/workflows')
@UseGuards(AccessTokenGuard, PermissionGuard)
@RequirePermission('system.admin.access')
export class WorkflowAdminController {
  constructor(@Inject(WorkflowService) private readonly workflowService: WorkflowService) {}

  @Get('templates')
  listTemplates(@Query('moduleKey') moduleKey?: string) {
    return this.workflowService.listTemplates(moduleKey ?? 'project');
  }

  @Post('templates')
  createTemplate(@Body() input: CreateWorkflowTemplateDto, @Req() request: AuthenticatedRequest) {
    return this.workflowService.createTemplate(input, request.auth.userId);
  }

  @Patch('templates/:id')
  @HttpCode(HttpStatus.OK)
  updateTemplate(@Param('id') id: string, @Body() input: UpdateWorkflowTemplateDto, @Req() request: AuthenticatedRequest) {
    return this.workflowService.updateTemplate(id, input, request.auth.userId);
  }

  /**
   * 删除流程模板（含其下版本与节点）。
   * 预置模板（isSystem）与仍被项目使用的模板会被拒绝，返回 409 并说明原因。
   */
  @Delete('templates/:id')
  @HttpCode(HttpStatus.OK)
  deleteTemplate(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.workflowService.deleteTemplate(id, request.auth.userId);
  }

  @Get('versions/:versionId')
  getVersion(@Param('versionId') versionId: string) {
    return this.workflowService.getVersion(versionId);
  }

  /** 新建版本；可传 copyFromVersionId 从既有版本复制节点（老流程锁定的落地方式） */
  @Post('templates/:templateId/versions')
  createVersion(@Param('templateId') templateId: string, @Body() input: CreateWorkflowVersionDto, @Req() request: AuthenticatedRequest) {
    return this.workflowService.createVersion(templateId, input, request.auth.userId);
  }

  /** 发布版本：同模板下旧版本自动转为 LOCKED */
  @Post('versions/:versionId/publish')
  @HttpCode(HttpStatus.OK)
  publishVersion(@Param('versionId') versionId: string, @Req() request: AuthenticatedRequest) {
    return this.workflowService.publishVersion(versionId, request.auth.userId);
  }

  @Post('versions/:versionId/nodes')
  createNode(@Param('versionId') versionId: string, @Body() input: WorkflowNodeDto, @Req() request: AuthenticatedRequest) {
    return this.workflowService.createNode(versionId, input, request.auth.userId);
  }

  @Patch('nodes/:nodeId')
  @HttpCode(HttpStatus.OK)
  updateNode(@Param('nodeId') nodeId: string, @Body() input: WorkflowNodeDto, @Req() request: AuthenticatedRequest) {
    return this.workflowService.updateNode(nodeId, input, request.auth.userId);
  }

  @Delete('nodes/:nodeId')
  @HttpCode(HttpStatus.OK)
  deleteNode(@Param('nodeId') nodeId: string, @Req() request: AuthenticatedRequest) {
    return this.workflowService.deleteNode(nodeId, request.auth.userId);
  }
}
