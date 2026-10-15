import { Body, ConflictException, Controller, Delete, Get, HttpCode, HttpStatus, Inject, NotFoundException, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { PermissionGuard } from '../auth/permission.guard';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { parseOptionModule } from './options.service';
import { generateInternalCode } from '../../infrastructure/identifiers/internal-code';

class CreateOptionDto {
  /** 技术编码由后端自动生成，保留可选字段兼容旧客户端。 */
  @IsOptional()
  @IsString()
  code?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;
}

class UpdateOptionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;

  /** 业务时限天数（PRD 4.7 系统算建议截止日）：仅合同类型使用；传 null 表示退回全局默认 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  timeLimitDays?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  timeLimitNote?: string;
}

/**
 * 系统 B：合同类型、项目类型等下拉选项的维护。
 *
 * 目的：合同类型/项目类型不再接受自由文本，避免同一类业务被写成「专利」「发明专利」「专利业务」，
 * 导致流程匹配、筛选与统计口径不一致。
 */
@Controller('api/admin/options')
@UseGuards(AccessTokenGuard, PermissionGuard)
@RequirePermission('system.admin.access')
export class OptionsAdminController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}

  @Get(':moduleKey')
  list(@Param('moduleKey') moduleKey: string) {
    return this.prisma.statusDefinition.findMany({
      where: { moduleKey: parseOptionModule(moduleKey) },
      orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }],
    });
  }

  @Post(':moduleKey')
  async create(@Param('moduleKey') moduleKey: string, @Body() input: CreateOptionDto, @Req() request: AuthenticatedRequest) {
    const module = parseOptionModule(moduleKey);
    const option = await this.prisma.statusDefinition.create({
      data: {
        moduleKey: module,
        code: generateInternalCode(`OPTION_${module}`),
        label: input.label,
        color: input.color ?? null,
        sortOrder: input.sortOrder ?? (await this.nextOptionSortOrder(module)),
        isSystem: false,
      },
    });
    await this.auditService.record({ actorId: request.auth.userId, action: 'CREATE', resourceType: 'OptionDefinition', resourceId: option.id, afterData: option });
    return option;
  }

  /**
   * 新增选项时的默认排序号：接在该模块现有最大值之后。
   *
   * 原实现默认写 0，新选项会直接排到最前面；界面上又默认给 (数量+1)×10，
   * 与"从 1 开始连续编号"的口径不一致。现在统一为「最大值 + 1」。
   */
  private async nextOptionSortOrder(moduleKey: string): Promise<number> {
    const aggregated = await this.prisma.statusDefinition.aggregate({
      where: { moduleKey },
      _max: { sortOrder: true },
    });
    return (aggregated._max.sortOrder ?? 0) + 1;
  }

  @Patch(':moduleKey/:id')
  @HttpCode(HttpStatus.OK)
  async update(@Param('moduleKey') moduleKey: string, @Param('id') id: string, @Body() input: UpdateOptionDto, @Req() request: AuthenticatedRequest) {
    const module = parseOptionModule(moduleKey);
    const before = await this.prisma.statusDefinition.findUnique({ where: { id } });
    if (!before || before.moduleKey !== module) throw new NotFoundException('选项不存在');
    if (!before.isActive) throw new ConflictException('该自定义类型已删除，不能继续编辑');
    if (before.isSystem && input.label !== undefined && input.label !== before.label) {
      throw new ConflictException('系统内置类型名称不可修改');
    }
    const option = await this.prisma.statusDefinition.update({
      where: { id },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.color !== undefined ? { color: input.color || null } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.timeLimitDays !== undefined ? { timeLimitDays: input.timeLimitDays } : {}),
        ...(input.timeLimitNote !== undefined ? { timeLimitNote: input.timeLimitNote || null } : {}),
      },
    });
    await this.auditService.record({ actorId: request.auth.userId, action: 'UPDATE', resourceType: 'OptionDefinition', resourceId: id, beforeData: before, afterData: option });
    return option;
  }

  @Delete(':moduleKey/:id')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('moduleKey') moduleKey: string, @Param('id') id: string, @Req() request: AuthenticatedRequest) {
    const module = parseOptionModule(moduleKey);
    const before = await this.prisma.statusDefinition.findUnique({ where: { id } });
    if (!before || before.moduleKey !== module) throw new NotFoundException('选项不存在');
    if (before.isSystem) throw new ConflictException('系统内置类型不可删除');
    if (!before.isActive) throw new ConflictException('该自定义类型已经删除');
    // 自定义类型删除采用软删除：已用该类型的历史合同仍要能正常显示
    const option = await this.prisma.statusDefinition.update({ where: { id }, data: { isActive: false } });
    await this.auditService.record({ actorId: request.auth.userId, action: 'SOFT_DELETE', resourceType: 'OptionDefinition', resourceId: id, beforeData: before, afterData: option });
    return { id, isActive: option.isActive };
  }
}
