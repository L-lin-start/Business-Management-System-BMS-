import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

type FieldDefinitionRow = {
  fieldKey: string;
  label: string;
  fieldType: string;
  isRequired: boolean;
  isSystem: boolean;
  config: Prisma.JsonValue | null;
};

export type CustomFieldContext = {
  /** 本次提交是否包含其它必填字段（更新时若未提交自定义字段则不强制必填） */
  partial?: boolean;
};

/**
 * 自定义字段的取值校验。
 *
 * 系统 B（管理系统 → 模块字段）配置的字段定义在这里生效：
 *   - 必填校验：isRequired 的字段必须有值（创建时强制，更新时只在提交了 customFields 的情况下校验）
 *   - 类型校验：NUMBER / DATE / BOOLEAN / MULTI_SELECT 等按 fieldType 校验
 *   - 选项校验：SELECT / MULTI_SELECT 的取值必须来自 config.options
 *   - 默认值：未提交时用 config.defaultValue 填充
 *   - 未定义字段：直接丢弃，避免 customFields 里堆积垃圾数据
 *
 * 这样系统 A 的录入端不需要理解字段定义，服务端统一兜底。
 */
@Injectable()
export class CustomFieldsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 读取模块下启用中的自定义字段定义（isSystem 的内置字段由业务表列承载，不进 customFields） */
  async listDefinitions(moduleKey: string): Promise<FieldDefinitionRow[]> {
    return this.prisma.fieldDefinition.findMany({
      where: { moduleKey, isActive: true, isSystem: false },
      orderBy: { sortOrder: 'asc' },
      select: { fieldKey: true, label: true, fieldType: true, isRequired: true, isSystem: true, config: true },
    });
  }

  /** 校验并归一化提交的 customFields，返回可直接写库的对象；无字段定义时返回 undefined。 */
  async sanitize(
    moduleKey: string,
    input: Record<string, unknown> | undefined,
    context: CustomFieldContext = {},
  ): Promise<Prisma.InputJsonValue | undefined> {
    const definitions = await this.listDefinitions(moduleKey);
    if (definitions.length === 0) return undefined;

    const submitted = input ?? {};
    const result: Record<string, unknown> = {};
    const errors: string[] = [];

    for (const definition of definitions) {
      const hasValue = Object.prototype.hasOwnProperty.call(submitted, definition.fieldKey);
      const rawValue = submitted[definition.fieldKey];
      const options = this.readOptions(definition.config);
      const defaultValue = this.readDefaultValue(definition.config);

      // 更新场景且本次未提交自定义字段时，不做必填校验，避免"改个金额却要求重填全部字段"
      if (definition.isRequired && !context.partial && (rawValue === undefined || rawValue === null || rawValue === '')) {
        errors.push(`${definition.label}为必填`);
        continue;
      }

      if (!hasValue || rawValue === undefined || rawValue === null || rawValue === '') {
        if (defaultValue !== undefined) result[definition.fieldKey] = defaultValue;
        continue;
      }

      const normalized = this.normalizeValue(definition.label, definition.fieldType, rawValue, options, errors);
      if (normalized !== undefined) result[definition.fieldKey] = normalized;
    }

    if (errors.length > 0) throw new BadRequestException(errors.join('；'));
    return Object.keys(result).length > 0 ? (result as Prisma.InputJsonValue) : undefined;
  }

  private normalizeValue(
    label: string,
    fieldType: string,
    rawValue: unknown,
    options: string[],
    errors: string[],
  ): unknown {
    switch (fieldType) {
      case 'NUMBER': {
        const parsed = Number(rawValue);
        if (!Number.isFinite(parsed)) {
          errors.push(`${label}必须是数字`);
          return undefined;
        }
        return parsed;
      }
      case 'BOOLEAN': {
        if (typeof rawValue === 'boolean') return rawValue;
        if (rawValue === 'true') return true;
        if (rawValue === 'false') return false;
        errors.push(`${label}必须是布尔值`);
        return undefined;
      }
      case 'DATE': {
        const parsed = new Date(String(rawValue));
        if (Number.isNaN(parsed.getTime())) {
          errors.push(`${label}必须是合法日期`);
          return undefined;
        }
        return parsed.toISOString();
      }
      case 'SELECT': {
        const value = String(rawValue);
        if (options.length > 0 && !options.includes(value)) {
          errors.push(`${label}的取值不在可选范围内`);
          return undefined;
        }
        return value;
      }
      case 'MULTI_SELECT': {
        const values = Array.isArray(rawValue) ? rawValue.map((item) => String(item)) : [String(rawValue)];
        if (options.length > 0) {
          const invalid = values.filter((item) => !options.includes(item));
          if (invalid.length > 0) {
            errors.push(`${label}存在无效选项`);
            return undefined;
          }
        }
        return values;
      }
      case 'RELATION':
      case 'USER':
      case 'TEXT':
      case 'ATTACHMENT':
      default: {
        if (typeof rawValue === 'object') {
          errors.push(`${label}必须是文本值`);
          return undefined;
        }
        return String(rawValue);
      }
    }
  }

  private readOptions(config: Prisma.JsonValue | null): string[] {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
    const options = (config as Record<string, unknown>).options;
    if (!Array.isArray(options)) return [];
    return options.map((item) => String(item));
  }

  private readDefaultValue(config: Prisma.JsonValue | null): unknown {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return undefined;
    const value = (config as Record<string, unknown>).defaultValue;
    return value === null || value === undefined || value === '' ? undefined : value;
  }
}
