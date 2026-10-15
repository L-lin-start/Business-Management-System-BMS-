import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { DataScope } from '@prisma/client';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { PermissionGuard } from '../auth/permission.guard';
import { DeleteReasonDto, RestoreReasonDto } from '../../infrastructure/delete/delete-reason.dto';
import { CostService } from './cost.service';
import { CreateCostDto, CostQueryDto, UpdateCostDto } from './dto/cost.dto';

@Controller('api/costs')
@UseGuards(AccessTokenGuard, PermissionGuard)
export class CostController {
  constructor(@Inject(CostService) private readonly costService: CostService) {}

  @Get()
  @RequirePermission('cost.read')
  list(@Query() query: CostQueryDto, @Req() request: AuthenticatedRequest) { return this.costService.list(query, request.auth.userId, this.scope(request)); }

  @Post()
  @RequirePermission('cost.manage')
  create(@Body() input: CreateCostDto, @Req() request: AuthenticatedRequest) { return this.costService.create(input, request.auth.userId); }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('cost.manage')
  update(@Param('id') id: string, @Body() input: UpdateCostDto, @Req() request: AuthenticatedRequest) { return this.costService.update(id, input, request.auth.userId, this.scope(request)); }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('cost.delete')
  remove(@Param('id') id: string, @Body() body: DeleteReasonDto, @Req() request: AuthenticatedRequest) { return this.costService.remove(id, request.auth.userId, this.scope(request), body.reason); }

  /** 恢复已删除的成本（PRD 7.1：仅管理员可恢复） */
  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('system.admin.access')
  restore(@Param('id') id: string, @Body() body: RestoreReasonDto, @Req() request: AuthenticatedRequest) { return this.costService.restore(id, request.auth.userId, body.reason); }

  private scope(request: AuthenticatedRequest) { return (request.auth.permissionScope ?? 'NONE') as DataScope; }
}
