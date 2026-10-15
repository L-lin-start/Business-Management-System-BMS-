import { BadRequestException, Controller, Get, HttpCode, HttpStatus, Inject, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, AuthenticatedRequest } from '../../modules/auth/access-token.guard';
import { buildContentDisposition } from './csv.util';
import { EXPORT_MODULES, ExportModule } from './export-definitions';
import { ExportService } from './export.service';

/**
 * 数据导出接口（PRD 4.12）。
 *
 * ## 路由设计
 *
 * `GET /api/export/:module` —— 一个入口覆盖五个模块，筛选参数与列表页一致：
 *
 * ```
 * /api/export/contract?keyword=HT&statusCode=ACTIVE
 * /api/export/project?contractId=xxx
 * /api/export/payment?contractId=xxx
 * ```
 *
 * 复用列表参数而不是另设一套，好处是"界面用什么条件筛，导出就是什么条件"。
 *
 * ## 权限
 *
 * 导出权限按模块不同（`customer.export` / `contract.export` / `project.export` /
 * `cost.export`，回款用 `payment.manage`，因为回款没有独立 export 权限点）。
 *
 * 共享的 `PermissionGuard` 只支持单个静态权限码，无法表达"按模块动态"，
 * 因此这里**不挂 `RequirePermission`**，权限与数据范围统一由
 * `ExportService.resolveScope()` 解析 —— 只有一个入口，不可能漏校验某个模块。
 */
@Controller('api/export')
@UseGuards(AccessTokenGuard)
export class ExportController {
  constructor(@Inject(ExportService) private readonly exportService: ExportService) {}

  @Get(':module')
  @HttpCode(HttpStatus.OK)
  async download(
    @Param('module') moduleKey: string,
    @Query() query: Record<string, string | undefined>,
    @Req() request: AuthenticatedRequest,
    @Res() response: any,
  ) {
    const module = this.parseModule(moduleKey);
    // 权限 + 数据范围一次解析：没有权限会抛 403，范围用于过滤（销售只能导出自己的）
    const scope = await this.exportService.resolveScope(module, request.auth.userId);
    const result = await this.exportService.run(module, query, request.auth.userId, scope);

    response.setHeader('Content-Type', result.contentType);
    response.setHeader('Content-Disposition', buildContentDisposition(result.filename));
    // 让前端能读到"导出了多少行 / 实际导出了哪些字段"
    response.setHeader('X-Export-Rows', String(result.rowCount));
    response.setHeader('X-Export-Fields', result.fields.join(','));
    response.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Rows, X-Export-Fields');
    response.end(result.buffer);
  }

  /** 未知模块直接 400，避免模块名拼错时静默导出一个空文件 */
  private parseModule(value: string): ExportModule {
    if ((EXPORT_MODULES as readonly string[]).includes(value)) return value as ExportModule;
    throw new BadRequestException(`不支持的导出模块「${value}」，可选：${EXPORT_MODULES.join(' / ')}`);
  }
}
