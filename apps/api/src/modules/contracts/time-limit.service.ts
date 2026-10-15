import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { addCalendarDays, formatCalendarDate, parseCalendarDate, startOfLocalDay } from '../../infrastructure/date/calendar-date';
import { OptionsService } from '../options/options.service';
import { ReminderService } from '../reminders/reminder.service';

const DEFAULT_TIME_LIMIT_KEY = 'reminder.defaultTimeLimitDays';
const DEFAULT_TIME_LIMIT_FALLBACK = 30;

export type TimeLimitSuggestion = {
  /** 建议的法定截止日（YYYY-MM-DD） */
  suggestedLegallyDueAt: string;
  /** 建议的内部安全日（YYYY-MM-DD） */
  suggestedInternalSafetyDate: string;
  /** 实际使用的时限天数 */
  timeLimitDays: number;
  /** 时限天数的来源：业务类型配置 / 全局默认 */
  timeLimitSource: 'CONTRACT_TYPE' | 'GLOBAL_DEFAULT';
  /** 内部安全日提前天数 */
  safetyMarginDays: number;
  /** 计算依据的可读说明，界面上直接展示，便于人工复核 */
  explanation: string;
  /** 是否因为合同到期日的限制而被压缩 */
  cappedByExpiryDate: boolean;
  /** 起算日 = 业务起算日（合同录入、项目绑定生成的那一刻） */
  baseDate: string;
  /** 起算日来源，固定为业务起算日，供前端在说明里标注 */
  baseDateSource: 'BUSINESS_START';
};

/**
 * 系统算建议截止日（PRD 4.7「系统算建议截止日，人工复核确认」）。
 *
 * 三步：
 *   1. **业务起算日** = 合同录入、项目绑定生成的时刻（合同与项目在同一事务里创建）。
 *      由系统自动产生，不需要人工填写；编辑已有合同时取该合同的录入时间。
 *   2. 建议法定截止日 = 业务起算日 + 该业务类型的时限天数；**不得晚于合同到期日**
 *   3. 建议内部安全日 = 建议法定截止日 - 内部安全日提前天数（复用提醒中心的 safetyMarginDays，
 *      这样"提前 15 天 / 7 天"由人工在系统 B 一处调整即可，不必两处维护）
 *
 * 系统只给建议值，最终以人工在表单里确认/修改的为准——PRD 明确要求「人工复核确认」。
 */
@Injectable()
export class TimeLimitService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ReminderService) private readonly reminderService: ReminderService,
    @Inject(OptionsService) private readonly optionsService: OptionsService,
  ) {}

  /** 读取全局默认时限天数 */
  async readDefaultTimeLimitDays(): Promise<number> {
    const row = await this.prisma.systemConfig.findUnique({ where: { key: DEFAULT_TIME_LIMIT_KEY } });
    const parsed = row ? Number(row.value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : DEFAULT_TIME_LIMIT_FALLBACK;
  }

  async updateDefaultTimeLimitDays(value: number, actorId?: string) {
    if (!Number.isInteger(value) || value < 1 || value > 3650) {
      throw new BadRequestException('默认业务时限天数必须是 1-3650 之间的整数');
    }
    await this.prisma.systemConfig.upsert({
      where: { key: DEFAULT_TIME_LIMIT_KEY },
      update: { value: String(value) },
      create: { key: DEFAULT_TIME_LIMIT_KEY, value: String(value), valueType: 'NUMBER', label: '默认业务时限天数（业务类型未单独配置时使用）' },
    });
    void actorId;
    return { defaultTimeLimitDays: value };
  }

  /** 合同类型各自配置的时限天数 */
  async listTypeTimeLimits() {
    const [types, defaultTimeLimitDays] = await Promise.all([
      this.prisma.statusDefinition.findMany({
        where: { moduleKey: 'contractType', isActive: true },
        orderBy: { sortOrder: 'asc' },
        select: { code: true, label: true, timeLimitDays: true, timeLimitNote: true },
      }),
      this.readDefaultTimeLimitDays(),
    ]);
    return { defaultTimeLimitDays, types };
  }

  /** 更新某个合同类型的时限天数；传 null 表示退回全局默认 */
  async updateTypeTimeLimit(moduleKey: string, id: string, input: { timeLimitDays?: number | null; timeLimitNote?: string }) {
    const target = await this.prisma.statusDefinition.findFirst({ where: { id, moduleKey } });
    if (!target) throw new BadRequestException('选项不存在');

    const days = input.timeLimitDays;
    if (days !== undefined && days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
      throw new BadRequestException('时限天数必须是 1-3650 之间的整数，或留空表示使用默认值');
    }

    return this.prisma.statusDefinition.update({
      where: { id },
      data: {
        ...(input.timeLimitDays !== undefined ? { timeLimitDays: input.timeLimitDays } : {}),
        ...(input.timeLimitNote !== undefined ? { timeLimitNote: input.timeLimitNote || null } : {}),
      },
      select: { id: true, code: true, label: true, timeLimitDays: true, timeLimitNote: true },
    });
  }

  /**
   * 计算建议截止日。
   * 不写库，只返回建议值供人工复核；保存时以表单里人工确认的日期为准。
   *
   * @param input.businessStartAt 新建或编辑时人工填写的业务起算日；未传时兼容旧数据。
   */
  async suggest(input: { contractType?: string; expiryDate?: string; businessStartAt?: string; contractId?: string }): Promise<TimeLimitSuggestion> {
    const contractType = (input.contractType ?? '').trim();
    if (!contractType) throw new BadRequestException('请先选择合同类型，系统才能推算建议截止日');

    // 合同类型可能传编码或标签，统一解析成编码后再取时限
    const code = await this.optionsService.assertOptionAllowed('contractType', contractType, '合同类型');
    const definition = await this.prisma.statusDefinition.findFirst({
      where: { moduleKey: 'contractType', code },
      select: { label: true, timeLimitDays: true, timeLimitNote: true },
    });

    const defaultTimeLimitDays = await this.readDefaultTimeLimitDays();
    const timeLimitDays = definition?.timeLimitDays ?? defaultTimeLimitDays;
    const timeLimitSource: TimeLimitSuggestion['timeLimitSource'] = definition?.timeLimitDays ? 'CONTRACT_TYPE' : 'GLOBAL_DEFAULT';
    const safetyMarginDays = await this.reminderService.readConfig('safetyMarginDays');

    // 业务起算日：优先使用人工填写值；旧合同未迁移时回退到历史创建时间。
    let businessStartAt = new Date();
    if (input.businessStartAt) {
      businessStartAt = parseCalendarDate(input.businessStartAt) ?? businessStartAt;
    } else if (input.contractId) {
      const existing = await this.prisma.contract.findUnique({
        where: { id: input.contractId },
      select: { createdAt: true, businessStartAt: true },
      });
      if (existing) businessStartAt = existing.businessStartAt ?? existing.createdAt;
    }
    const baseDate = startOfLocalDay(businessStartAt);
    let suggestedDue = addCalendarDays(baseDate, timeLimitDays);

    // 合同到期即结束，建议的法定截止日不应晚于到期日
    let cappedByExpiryDate = false;
    const expiry = input.expiryDate ? startOfLocalDay(parseCalendarDate(input.expiryDate) ?? new Date()) : null;
    if (expiry && suggestedDue.getTime() > expiry.getTime()) {
      suggestedDue = expiry;
      cappedByExpiryDate = true;
    }

    const suggestedSafety = addCalendarDays(suggestedDue, -safetyMarginDays);
    const baseDateText = formatCalendarDate(baseDate);
    const dueText = formatCalendarDate(suggestedDue);
    const safetyText = formatCalendarDate(suggestedSafety);
    const typeLabel = definition?.label ?? contractType;
    const sourceText = timeLimitSource === 'CONTRACT_TYPE' ? `「${typeLabel}」时限 ${timeLimitDays} 天` : `全局默认时限 ${timeLimitDays} 天`;

    const explanation = [
      `法定截止日：人工填写的业务起算日 ${baseDateText} + ${sourceText} = ${dueText}`,
      cappedByExpiryDate ? `（因超过合同到期日，已压缩到到期日 ${dueText}）` : '',
      `内部安全日：法定截止日 ${dueText} - 安全天数 ${safetyMarginDays} 天 = ${safetyText}`,
      '以上为系统建议值，请人工复核后确认或修改。',
    ]
      .filter(Boolean)
      .join('；');

    return {
      suggestedLegallyDueAt: dueText,
      suggestedInternalSafetyDate: safetyText,
      timeLimitDays,
      timeLimitSource,
      safetyMarginDays,
      explanation,
      cappedByExpiryDate,
      baseDate: baseDateText,
      baseDateSource: 'BUSINESS_START',
    };
  }
}

