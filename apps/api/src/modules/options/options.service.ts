import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';

/** 可用作下拉选项的枚举模块：状态枚举 + 各类受控下拉 */
export const OPTION_MODULES = [
  // 状态枚举
  'contract',
  'project',
  // 受控下拉（合同类型/项目类型在系统 A 是下拉选择，不接受自由文本）
  'contractType',
  'projectType',
  'paymentTerm',
  // 合同终止（PRD 4.2 的 5 要素里有 4 个是选项）
  'terminationType',
  'unfinishedProjectAction',
  'unpaidAmountAction',
  // 金额调整（退款/折扣/部分豁免）
  'adjustType',
  // 附属业务数据的受控下拉（PRD 4.6 / 4.8 / 4.9 / 8.5）
  // 注意：新增受控下拉必须同时加进这个白名单，否则接口会返回 400 且前端下拉静默变空。
  'mailDeliveryStatus',
  'actionType',
  'filingResult',
  'officialDocumentType',
  'officialDocumentSource',
] as const;
export type OptionModuleKey = (typeof OPTION_MODULES)[number];

export function parseOptionModule(value: string): OptionModuleKey {
  if ((OPTION_MODULES as readonly string[]).includes(value)) return value as OptionModuleKey;
  throw new BadRequestException(`不支持的选项模块：${value}`);
}

/**
 * 下拉选项读取：状态枚举、合同类型、项目类型统一从这里取，页面不写死中文。
 * 维护入口在系统 B（管理系统），本接口只读。
 */
@Injectable()
export class OptionsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 全部启用中的定义，按模块分组，例如 { contract: [...], project: [...], contractType: [...] } */
  async listStatuses() {
    const rows = await this.prisma.statusDefinition.findMany({
      where: { isActive: true },
      orderBy: [{ moduleKey: 'asc' }, { sortOrder: 'asc' }],
      select: {
        moduleKey: true,
        code: true,
        label: true,
        color: true,
        statisticsCode: true,
        sortOrder: true,
      },
    });

    return rows.reduce<Record<string, typeof rows>>((grouped, row) => {
      grouped[row.moduleKey] = [...(grouped[row.moduleKey] ?? []), row];
      return grouped;
    }, {});
  }

  /** 某个模块的选项列表（合同类型 / 项目类型等） */
  async listOptions(moduleKey: OptionModuleKey) {
    return this.prisma.statusDefinition.findMany({
      where: { moduleKey, isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, label: true, color: true, sortOrder: true },
    });
  }

  /**
   * 校验提交的选项值是否在允许范围内。
   * 合同类型/项目类型/付款方式/金额调整类型等受控字段都用它，避免自由文本与非法编码。
   */
  async assertOptionAllowed(moduleKey: string, value: string, fieldLabel: string) {
    const matched = await this.prisma.statusDefinition.findFirst({
      where: { moduleKey, isActive: true, OR: [{ code: value }, { label: value }] },
      select: { code: true },
    });
    if (!matched) {
      throw new BadRequestException(`${fieldLabel}「${value}」不在可选范围内，请在管理系统的选项配置中先添加`);
    }
    return matched.code;
  }

  /**
   * 把选项编码解析为展示标签（合同类型 PATENT → 专利）。
   * 项目类型需要中文标签才能匹配同名流程模板，因此这里提供解析。
   */
  async resolveOptionLabel(moduleKey: string, value: string | null | undefined): Promise<string | null> {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return null;
    const matched = await this.prisma.statusDefinition.findFirst({
      where: { moduleKey, OR: [{ code: trimmed }, { label: trimmed }] },
      select: { label: true },
    });
    return matched?.label ?? trimmed;
  }

  /**
   * 某个模块的自定义字段定义（isSystem 的内置字段由前端表单固定渲染，不在这里返回）。
   * 系统 A 用它动态渲染录入表单与列表列。
   */
  async listCustomFields(moduleKey: string) {
    return this.prisma.fieldDefinition.findMany({
      where: { moduleKey, isActive: true, isSystem: false },
      orderBy: { sortOrder: 'asc' },
      select: {
        fieldKey: true,
        label: true,
        fieldType: true,
        isRequired: true,
        isListVisible: true,
        isSearchable: true,
        sortOrder: true,
        config: true,
      },
    });
  }
}
