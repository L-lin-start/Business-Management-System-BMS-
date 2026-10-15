import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Put, UseGuards } from '@nestjs/common';
import { AccessTokenGuard } from '../../modules/auth/access-token.guard';
import { PermissionGuard } from '../../modules/auth/permission.guard';
import { RequirePermission } from '../../modules/auth/permission.decorator';
import { EXPORT_MODULES, ExportModule } from './export-definitions';
import { ExportService } from './export.service';

/**
 * 导出配置（PRD 5.10「导出模板、导出字段、导出格式可配」）。
 *
 * 按模块配置：
 *   - `fields`：导出哪些列（勾选，顺序固定按定义顺序，管理员改不了顺序，避免误操作）
 *   - `format`：csv / xlsx
 *
 * 配置存在 `SystemConfig`（key = `export.config.<module>`），因此不需要数据库迁移。
 * 只有系统管理员能改（`system.admin.access`）—— 导出格式是全局影响，不适合下放。
 */
@Controller('api/admin/export-configs')
@UseGuards(AccessTokenGuard, PermissionGuard)
export class ExportConfigAdminController {
  constructor(@Inject(ExportService) private readonly exportService: ExportService) {}

  @Get()
  @RequirePermission('system.admin.access')
  list() {
    return this.exportService.listConfigs();
  }

  @Put(':module')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('system.admin.access')
  save(@Param('module') moduleKey: string, @Body() input: { format?: string; fields?: string[] }) {
    const module = EXPORT_MODULES.find((item) => item === moduleKey) as ExportModule | undefined;
    if (!module) throw new BadRequestException(`不支持的导出模块「${moduleKey}」`);
    return this.exportService.saveConfig(module, input);
  }
}
