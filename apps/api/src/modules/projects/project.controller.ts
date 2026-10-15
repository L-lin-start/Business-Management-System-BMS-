import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { DataScope } from '@prisma/client';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { PermissionGuard } from '../auth/permission.guard';
import { HistoryService } from '../history/history.service';
import { DeleteReasonDto, RestoreReasonDto } from '../../infrastructure/delete/delete-reason.dto';
import { ProjectService } from './project.service';
import { CreateProjectDto, ProjectQueryDto, UpdateProjectDto } from './dto/project.dto';

@Controller('api/projects')
@UseGuards(AccessTokenGuard, PermissionGuard)
export class ProjectController {
  constructor(
    @Inject(ProjectService) private readonly projectService: ProjectService,
    @Inject(HistoryService) private readonly historyService: HistoryService,
  ) {}

  @Get()
  @RequirePermission('project.read')
  list(@Query() query: ProjectQueryDto, @Req() request: AuthenticatedRequest) {
    return this.projectService.list(query, request.auth.userId, this.scope(request));
  }

  @Get(':id')
  @RequirePermission('project.read')
  getById(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.projectService.getById(id, request.auth.userId, this.scope(request));
  }

  /** 项目状态变化历史（详情页时间线） */
  @Get(':id/status-history')
  @RequirePermission('project.read')
  async statusHistory(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    await this.projectService.assertAccess(id, request.auth.userId, this.scope(request));
    return this.historyService.listStatusHistory('Project', id);
  }

  /** 项目节点流转历史（阶段 1b 的流程推进会写入，此处先提供读取） */
  @Get(':id/node-history')
  @RequirePermission('project.read')
  async nodeHistory(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    await this.projectService.assertAccess(id, request.auth.userId, this.scope(request));
    return this.historyService.listNodeHistory(id);
  }

  @Post()
  @RequirePermission('project.manage')
  create(@Body() input: CreateProjectDto, @Req() request: AuthenticatedRequest) {
    return this.projectService.create(input, request.auth.userId, this.scope(request));
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('project.manage')
  update(@Param('id') id: string, @Body() input: UpdateProjectDto, @Req() request: AuthenticatedRequest) {
    return this.projectService.update(id, input, request.auth.userId, this.scope(request));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('project.delete')
  softDelete(@Param('id') id: string, @Body() body: DeleteReasonDto, @Req() request: AuthenticatedRequest) {
    return this.projectService.softDelete(id, request.auth.userId, this.scope(request), body.reason);
  }

  /** 恢复已删除的项目（PRD 7.1：仅管理员可恢复） */
  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('system.admin.access')
  restore(@Param('id') id: string, @Body() body: RestoreReasonDto, @Req() request: AuthenticatedRequest) {
    return this.projectService.restore(id, request.auth.userId, body.reason);
  }

  private scope(request: AuthenticatedRequest) {
    return (request.auth.permissionScope ?? 'NONE') as DataScope;
  }
}
