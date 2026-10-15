/**
 * 导出定义（PRD 4.12 / 5.10）。
 *
 * ## PRD 要求
 *
 * > 导出：操作级按钮，例如合同列表页「导出合同列表」、合同详情页「导出本合同」、
 * > 项目列表页「导出项目列表」、回款列表页「导出回款记录」。导出权限由系统B配置。
 * >
 * > 5.10 导出配置：导出模板、导出字段、导出格式可配。
 *
 * ## 本文件负责什么
 *
 * 定义每个模块**可导出哪些字段**、默认导出哪些、以及默认格式。
 * 管理员在「管理系统 → 导出配置」里可以按模块调整：
 *   - 勾选/取消字段（对应 PRD 的"导出字段可配"）
 *   - 切换格式 csv / xlsx（对应"导出格式可配"）
 *
 * 配置存在 `SystemConfig`（key-value 表），因此**不需要数据库迁移**。
 */
import { Inject } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

/** 导出格式（PRD 5.10「导出格式可配」） */
export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** 可导出的模块。key 同时决定权限点与配置存储的键名。 */
export const EXPORT_MODULES = ['customer', 'contract', 'project', 'payment', 'cost'] as const;
export type ExportModule = (typeof EXPORT_MODULES)[number];

export type ExportColumnDef = {
  /** 列 key，配置里用它标识字段 */
  key: string;
  /** 导出后的表头 */
  header: string;
  /** 是否默认导出（管理员未调整时用） */
  default?: boolean;
};

export type ExportModuleDef = {
  module: ExportModule;
  /** 中文名，用于界面与文件名 */
  label: string;
  /**
   * 导出所需权限。
   * 用数组表示"任一满足即可"：回款没有独立 export 权限点，
   * 因此回款导出要求 `payment.manage`（能登记回款就能导出回款）。
   */
  permissions: string[];
  columns: ExportColumnDef[];
};

/** 一个模块的完整列定义（含取值函数）。取值函数不参与配置，只按 key 过滤。 */
export type ExportColumn<T> = ExportColumnDef & { value: (row: T) => unknown };

/**
 * 模块定义。
 *
 * 列顺序即默认导出顺序；`default: false` 的列默认不导出（可在配置里打开）。
 */
export const EXPORT_DEFINITIONS: Record<ExportModule, ExportModuleDef> = {
  customer: {
    module: 'customer',
    label: '客户',
    permissions: ['customer.export'],
    columns: [
      { key: 'name', header: '客户名称', default: true },
      { key: 'customerType', header: '客户类型', default: true },
      { key: 'contactName', header: '联系人', default: true },
      { key: 'phone', header: '联系电话', default: true },
      { key: 'email', header: '邮箱', default: true },
      { key: 'address', header: '地址', default: true },
      { key: 'ownerName', header: '所属销售', default: true },
      { key: 'createdAt', header: '创建时间', default: true },
    ],
  },
  contract: {
    module: 'contract',
    label: '合同',
    permissions: ['contract.export'],
    columns: [
      { key: 'contractNo', header: '合同编号', default: true },
      { key: 'customerName', header: '客户名称', default: true },
      { key: 'contractType', header: '合同类型', default: true },
      { key: 'amount', header: '合同金额', default: true },
      { key: 'collectedAmount', header: '已收款', default: true },
      { key: 'unpaidAmount', header: '未收款', default: true },
      { key: 'costAmount', header: '成本', default: true },
      { key: 'netProfit', header: '净收益', default: true },
      { key: 'itemCount', header: '件数', default: true },
      { key: 'projectCount', header: '项目数', default: true },
      { key: 'statusLabel', header: '合同状态', default: true },
      { key: 'signedAt', header: '签订日期', default: true },
      { key: 'expiryDate', header: '合同到期日', default: true },
      { key: 'ownerName', header: '合同负责人', default: true },
      { key: 'remark', header: '备注', default: false },
      { key: 'createdAt', header: '创建时间', default: false },
      { key: 'terminatedAt', header: '终止日期', default: false },
      { key: 'terminationReason', header: '终止原因', default: false },
    ],
  },
  project: {
    module: 'project',
    label: '项目',
    permissions: ['project.export'],
    columns: [
      { key: 'projectNo', header: '项目编号', default: true },
      { key: 'projectName', header: '项目名称', default: true },
      { key: 'contractNo', header: '所属合同', default: true },
      { key: 'customerName', header: '客户名称', default: true },
      { key: 'projectType', header: '项目类型', default: true },
      { key: 'statusLabel', header: '项目状态', default: true },
      { key: 'currentNodeName', header: '当前节点', default: true },
      { key: 'ownerName', header: '项目负责人', default: true },
      { key: 'startDate', header: '业务起算日期', default: true },
      { key: 'dueDate', header: '项目截止日', default: true },
      { key: 'collectedAmount', header: '本项目回款', default: true },
      { key: 'costAmount', header: '本项目成本', default: true },
      { key: 'netProfit', header: '项目净收益', default: true },
      { key: 'sequence', header: '序号', default: false },
      { key: 'createdAt', header: '创建时间', default: false },
    ],
  },
  payment: {
    module: 'payment',
    label: '回款',
    // 回款没有独立 export 权限点（历史上被合并为 payment.manage），
    // 因此"能登记回款"即"能导出回款"。
    permissions: ['payment.manage'],
    columns: [
      { key: 'receiptNo', header: '回款单号', default: true },
      { key: 'contractNo', header: '所属合同', default: true },
      { key: 'customerName', header: '客户名称', default: true },
      { key: 'amount', header: '回款金额', default: true },
      { key: 'receivedAt', header: '回款日期', default: true },
      { key: 'paymentMethod', header: '回款方式', default: true },
      { key: 'allocatedProjects', header: '分摊到项目', default: true },
      { key: 'note', header: '备注', default: true },
      { key: 'createdAt', header: '登记时间', default: false },
    ],
  },
  cost: {
    module: 'cost',
    label: '成本',
    permissions: ['cost.export'],
    columns: [
      { key: 'costType', header: '费用类型', default: true },
      { key: 'amount', header: '金额', default: true },
      { key: 'incurredAt', header: '发生日期', default: true },
      { key: 'projectNo', header: '所属项目', default: true },
      { key: 'contractNo', header: '所属合同', default: true },
      { key: 'note', header: '备注', default: true },
      { key: 'createdAt', header: '登记时间', default: false },
    ],
  },
};

/** 文本枚举在导出时转成中文（否则会导出 PATENT / IN_PROGRESS 这类内部编码） */
export const EXPORT_STATUS_LABELS: Record<string, string> = {
  ACTIVE: '生效',
  IN_PROGRESS: '执行中',
  COMPLETED: '已完成',
  TERMINATED: '已终止',
  PENDING: '待完成',
  EXCEPTION: '异常',
};

export type ExportModuleConfig = {
  /** 导出格式 */
  format: ExportFormat;
  /** 勾选的字段 key（顺序按定义顺序） */
  fields: string[];
};

/** 每个模块的配置存在这个键下：export.config.<module> */
export function exportConfigKey(module: ExportModule): string {
  return `export.config.${module}`;
}

/** 默认配置：全部默认列 + CSV */
export function defaultExportConfig(module: ExportModule): ExportModuleConfig {
  return {
    format: 'csv',
    fields: EXPORT_DEFINITIONS[module].columns.filter((column) => column.default !== false).map((column) => column.key),
  };
}

export class ExportConfigService {
  // 显式 @Inject：这个仓库统一用显式注入，靠类型反射在部分场景拿不到元数据会变成 undefined
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 读取所有模块的导出配置（缺省补默认值） */
  async listAll(): Promise<Array<{ module: ExportModule; label: string; available: ExportColumnDef[]; config: ExportModuleConfig }>> {
    const rows = await this.prisma.systemConfig.findMany({
      where: { key: { in: EXPORT_MODULES.map((module) => exportConfigKey(module)) } },
      select: { key: true, value: true },
    });
    const stored = new Map<string, string>(rows.map((row) => [row.key, String(row.value ?? '')]));

    return EXPORT_MODULES.map((module) => {
      const definition = EXPORT_DEFINITIONS[module];
      return {
        module,
        label: definition.label,
        // 只暴露 key / header / default，取值函数不出去
        available: definition.columns.map((column): ExportColumnDef => {
          const item: ExportColumnDef = { key: column.key, header: column.header };
          if (column.default !== undefined) item.default = column.default;
          return item;
        }),
        config: this.normalize(module, stored.get(exportConfigKey(module))),
      };
    });
  }

  /** 读取单个模块配置 */
  async get(module: ExportModule): Promise<ExportModuleConfig> {
    const row = await this.prisma.systemConfig.findUnique({ where: { key: exportConfigKey(module) }, select: { value: true } });
    return this.normalize(module, row?.value == null ? null : String(row.value));
  }

  /** 保存单个模块配置 */
  async save(module: ExportModule, input: { format?: string; fields?: string[] }): Promise<ExportModuleConfig> {
    const next = this.normalize(module, JSON.stringify(input));
    await this.prisma.systemConfig.upsert({
      where: { key: exportConfigKey(module) },
      create: {
        key: exportConfigKey(module),
        value: JSON.stringify(next),
        // JSON 字符串，与 reminder.* 那些数字型配置区分开
        valueType: 'JSON',
        label: `${EXPORT_DEFINITIONS[module].label}导出配置`,
      },
      update: { value: JSON.stringify(next) },
    });
    return next;
  }

  /**
   * 把存储值规整成合法配置。
   *
   * 防御点：
   *   - 存储被写坏（非 JSON）→ 回退默认
   *   - 字段 key 已不存在（模块改过）→ 丢弃
   *   - fields 为空 → 回退默认（否则导出会变成只有一个空行）
   *   - 顺序按定义顺序（管理员改不了顺序，避免误操作）
   */
  private normalize(module: ExportModule, raw: string | null | undefined): ExportModuleConfig {
    const fallback = defaultExportConfig(module);
    if (!raw) return fallback;
    let parsed: { format?: unknown; fields?: unknown };
    try {
      parsed = JSON.parse(raw) as { format?: unknown; fields?: unknown };
    } catch {
      return fallback;
    }
    const format: ExportFormat = EXPORT_FORMATS.includes(parsed.format as ExportFormat) ? (parsed.format as ExportFormat) : fallback.format;
    const known = new Set(EXPORT_DEFINITIONS[module].columns.map((column) => column.key));
    const picked = Array.isArray(parsed.fields) ? parsed.fields.filter((key): key is string => typeof key === 'string' && known.has(key)) : [];
    const ordered = EXPORT_DEFINITIONS[module].columns.filter((column) => picked.includes(column.key)).map((column) => column.key);
    return { format, fields: ordered.length > 0 ? ordered : fallback.fields };
  }
}
