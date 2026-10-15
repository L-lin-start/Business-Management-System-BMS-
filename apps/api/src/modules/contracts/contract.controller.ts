import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { DataScope } from '@prisma/client';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { PermissionGuard } from '../auth/permission.guard';
import { HistoryService } from '../history/history.service';
import { DeleteReasonDto, RestoreReasonDto } from '../../infrastructure/delete/delete-reason.dto';
import { ContractService } from './contract.service';
import { TimeLimitService } from './time-limit.service';
import { CreateContractDto, ContractQueryDto, CreateContractAdjustmentDto, TerminateContractDto, UpdateContractDto } from './dto/contract.dto';

@Controller('api/contracts')
@UseGuards(AccessTokenGuard, PermissionGuard)
export class ContractController {
  constructor(
    @Inject(ContractService) private readonly contractService: ContractService,
    @Inject(HistoryService) private readonly historyService: HistoryService,
    @Inject(TimeLimitService) private readonly timeLimitService: TimeLimitService,
  ) {}

  @Get()
  @RequirePermission('contract.read')
  list(@Query() query: ContractQueryDto, @Req() request: AuthenticatedRequest) {
    return this.contractService.list(query, request.auth.userId, this.scope(request));
  }

  /**
   * 系统算建议截止日（PRD 4.7）：返回建议的法定截止日与内部安全日供人工复核。
   * 起算点是**业务起算日**（合同录入、项目绑定生成的时刻）：
   *   - 新建合同时不传 contractId，用当前时刻作起算日
   *   - 编辑已有合同时传 contractId，用该合同的录入时间作起算日
   * 只算不写库；保存时以表单里人工确认的日期为准。
   * 注意：必须声明在 @Get(':id') 之前，否则会被 :id 路由吃掉。
   */
  @Get('suggest-deadline')
  @RequirePermission('contract.read')
  suggestDeadline(
    @Query('contractType') contractType?: string,
    @Query('expiryDate') expiryDate?: string,
    @Query('businessStartAt') businessStartAt?: string,
    @Query('contractId') contractId?: string,
  ) {
    return this.timeLimitService.suggest({
      ...(contractType ? { contractType } : {}),
      ...(expiryDate ? { expiryDate } : {}),
      ...(businessStartAt ? { businessStartAt } : {}),
      ...(contractId ? { contractId } : {}),
    });
  }

  @Get(':id')
  @RequirePermission('contract.read')
  getById(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.contractService.getById(id, request.auth.userId, this.scope(request));
  }

  /** 合同状态变化历史（详情页时间线） */
  @Get(':id/status-history')
  @RequirePermission('contract.read')
  statusHistory(@Param('id') id: string) {
    return this.historyService.listStatusHistory('Contract', id);
  }

  /** 合同金额调整明细（退款/折扣/部分豁免）与累计额 */
  @Get(':id/adjustments')
  @RequirePermission('contract.read')
  adjustments(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.contractService.listAdjustments(id, request.auth.userId, this.scope(request));
  }

  /** 合同终止：一次记录 PRD 4.2 要求的 5 个要素 */
  @Post(':id/terminate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contract.terminate')
  terminate(@Param('id') id: string, @Body() input: TerminateContractDto, @Req() request: AuthenticatedRequest) {
    return this.contractService.terminate(id, input, request.auth.userId, this.scope(request));
  }

  /** 新增金额调整（退款/折扣/部分豁免），单独记账不改原金额 */
  @Post(':id/adjustments')
  @RequirePermission('contract.manage')
  createAdjustment(
    @Param('id') id: string,
    @Body() input: CreateContractAdjustmentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.contractService.createAdjustment(id, input, request.auth.userId, this.scope(request));
  }

  @Delete(':id/adjustments/:adjustmentId')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contract.manage')
  removeAdjustment(
    @Param('id') id: string,
    @Param('adjustmentId') adjustmentId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.contractService.removeAdjustment(id, adjustmentId, request.auth.userId, this.scope(request));
  }

  @Post()
  @RequirePermission('contract.manage')
  create(@Body() input: CreateContractDto, @Req() request: AuthenticatedRequest) {
    return this.contractService.create(input, request.auth.userId, this.scope(request));
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contract.manage')
  update(@Param('id') id: string, @Body() input: UpdateContractDto, @Req() request: AuthenticatedRequest) {
    return this.contractService.update(id, input, request.auth.userId, this.scope(request));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('contract.delete')
  softDelete(@Param('id') id: string, @Body() body: DeleteReasonDto, @Req() request: AuthenticatedRequest) {
    return this.contractService.softDelete(id, request.auth.userId, this.scope(request), body.reason);
  }

  /** 恢复已删除的合同（PRD 7.1：仅管理员可恢复） */
  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('system.admin.access')
  restore(@Param('id') id: string, @Body() body: RestoreReasonDto, @Req() request: AuthenticatedRequest) {
    return this.contractService.restore(id, request.auth.userId, body.reason);
  }

  private scope(request: AuthenticatedRequest) {
    return (request.auth.permissionScope ?? 'NONE') as DataScope;
  }
}

/** 系统 B：业务时限天数配置（PRD 4.7 系统算建议截止日的数据来源） */
@Controller('api/admin/time-limits')
@UseGuards(AccessTokenGuard, PermissionGuard)
@RequirePermission('system.admin.access')
export class TimeLimitAdminController {
  constructor(@Inject(TimeLimitService) private readonly timeLimitService: TimeLimitService) {}

  @Get()
  list() {
    return this.timeLimitService.listTypeTimeLimits();
  }

  /** 全局默认时限：业务类型未单独配置时使用 */
  @Post('default')
  @HttpCode(HttpStatus.OK)
  updateDefault(@Body() input: { defaultTimeLimitDays: number }) {
    return this.timeLimitService.updateDefaultTimeLimitDays(Number(input.defaultTimeLimitDays));
  }

  /** 某个合同类型的时限天数；传 null 表示退回全局默认 */
  @Patch('types/:id')
  @HttpCode(HttpStatus.OK)
  updateType(@Param('id') id: string, @Body() input: { timeLimitDays?: number | null; timeLimitNote?: string }) {
    return this.timeLimitService.updateTypeTimeLimit('contractType', id, input);
  }
}
