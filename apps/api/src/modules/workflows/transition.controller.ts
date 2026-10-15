import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { DataScope } from '@prisma/client';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { PermissionGuard } from '../auth/permission.guard';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { TransitionService } from './transition.service';

class ProjectTransitionDto {
  /** 目标节点编码；缺省推进到下一个节点 */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  toNodeCode?: string;

  /** 客户端读到的项目版本号，用于乐观锁 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * 项目节点推进。权限点 `project.transition` 与 `project.manage` 分开：
 * 能改项目信息不等于能推进流程（PRD 3.2 的节点权限）。
 */
@Controller('api/projects/:id')
@UseGuards(AccessTokenGuard, PermissionGuard)
export class TransitionController {
  constructor(@Inject(TransitionService) private readonly transitionService: TransitionService) {}

  @Get('transitions')
  @RequirePermission('project.read')
  available(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.transitionService.availableTransitions(id, request.auth.userId, this.scope(request));
  }

  @Post('transitions')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('project.transition')
  transition(@Param('id') id: string, @Body() input: ProjectTransitionDto, @Req() request: AuthenticatedRequest) {
    return this.transitionService.transition(id, input, request.auth.userId, this.scope(request));
  }

  private scope(request: AuthenticatedRequest) {
    return (request.auth.permissionScope ?? 'NONE') as DataScope;
  }
}
