import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { DataScope, ReminderType } from '@prisma/client';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { PermissionGuard } from '../auth/permission.guard';
import { REMINDER_CONFIG, ReminderService } from './reminder.service';

class HandleReminderDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

class UpdateReminderConfigDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) contractAdvanceDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) nodeAdvanceDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) safetyMarginDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) retentionDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1440) scanIntervalMinutes?: number;
}

/**
 * 提醒中心。
 * 查看用 reminder.read，处理用 reminder.handle（能看不等于能销掉）。
 */
@Controller('api/reminders')
@UseGuards(AccessTokenGuard, PermissionGuard)
export class ReminderController {
  constructor(@Inject(ReminderService) private readonly reminderService: ReminderService) {}

  @Get()
  @RequirePermission('reminder.read')
  list(
    @Req() request: AuthenticatedRequest,
    @Query('isHandled') isHandled?: string,
    @Query('type') type?: string,
    @Query('sourceType') sourceType?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('scan') scan?: string,
  ) {
    return this.reminderService.list(
      {
        ...(isHandled === 'true' || isHandled === 'false' ? { isHandled } : {}),
        ...(type ? { type: type as ReminderType } : {}),
        ...(sourceType ? { sourceType } : {}),
        ...(scan ? { scan } : {}),
        page: Number(page),
        pageSize: Number(pageSize),
      },
      // 数据范围由 PermissionGuard 按 reminder.read 的 dataScope 解析后写入 request.auth
      this.viewer(request),
    );
  }

  /** 首页看板用的汇总：未处理数、逾期数、按类型分布 */
  @Get('summary')
  @RequirePermission('reminder.read')
  async summary(@Req() request: AuthenticatedRequest) {
    const result = await this.reminderService.list(
      { isHandled: 'false', page: 1, pageSize: 5, scan: 'false' },
      this.viewer(request),
    );
    return { ...result.summary, latest: result.items };
  }

  /** PRD 第十章「卡片四：待办提醒」口径：今日待办 / 逾期项目 / 超时邮件登记 / 待回款合同 */
  @Get('prd-summary')
  @RequirePermission('reminder.read')
  prdSummary(@Req() request: AuthenticatedRequest) {
    return this.reminderService.prdSummary(this.viewer(request));
  }

  /** 当前登录人与其提醒数据范围（未登录/无范围时按 NONE 处理，看不到任何数据） */
  private viewer(request: AuthenticatedRequest) {
    return { userId: request.auth.userId, dataScope: (request.auth.permissionScope ?? 'NONE') as DataScope };
  }

  @Post('scan')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('reminder.handle')
  scan(@Req() request: AuthenticatedRequest) {
    return this.reminderService.scan({ trigger: 'MANUAL', actorId: request.auth.userId });
  }

  @Post(':id/handle')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('reminder.handle')
  handle(@Param('id') id: string, @Body() input: HandleReminderDto, @Req() request: AuthenticatedRequest) {
    // 带上数据范围：看不到的提醒不允许处理（防止把别人的待办标记掉）
    return this.reminderService.handle(id, input, request.auth.userId, (request.auth.permissionScope ?? 'NONE') as DataScope);
  }

  @Post(':id/unhandle')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('reminder.handle')
  unhandle(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.reminderService.unhandle(id, request.auth.userId, (request.auth.permissionScope ?? 'NONE') as DataScope);
  }
}

/** 系统 B：提醒参数配置 */
@Controller('api/admin/reminder-config')
@UseGuards(AccessTokenGuard, PermissionGuard)
@RequirePermission('system.admin.access')
export class ReminderConfigController {
  constructor(@Inject(ReminderService) private readonly reminderService: ReminderService) {}

  @Get()
  list() {
    return this.reminderService.listConfig();
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  update(@Body() input: UpdateReminderConfigDto, @Req() request: AuthenticatedRequest) {
    const allowed = Object.keys(REMINDER_CONFIG);
    const payload = Object.fromEntries(
      Object.entries(input).filter(([key, value]) => allowed.includes(key) && value !== undefined),
    );
    return this.reminderService.updateConfig(payload, request.auth.userId);
  }
}
