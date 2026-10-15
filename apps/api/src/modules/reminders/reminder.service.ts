import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataScope, Prisma, ReminderType } from '@prisma/client';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { ProjectAccessScopeService } from '../../infrastructure/project-access/project-access-scope.service';

/** 提醒参数配置键与默认值 */
export const REMINDER_CONFIG = {
  contractAdvanceDays: { key: 'reminder.contractAdvanceDays', label: '合同到期提前提醒天数', defaultValue: 30, min: 0, max: 365 },
  nodeAdvanceDays: { key: 'reminder.nodeAdvanceDays', label: '流程节点提前提醒天数', defaultValue: 3, min: 0, max: 365 },
  safetyMarginDays: { key: 'reminder.safetyMarginDays', label: '内部安全日提前于法定截止日的天数', defaultValue: 7, min: 0, max: 365 },
  retentionDays: { key: 'reminder.retentionDays', label: '已处理提醒保留天数', defaultValue: 7, min: 1, max: 365 },
  scanIntervalMinutes: { key: 'reminder.scanIntervalMinutes', label: '自动扫描间隔（分钟，0 表示不自动扫描）', defaultValue: 60, min: 0, max: 1440 },
  // 分级预警（PRD 4.7）：剩余天数 ≤ 阈值时升级级别
  tierNoticeDays: { key: 'reminder.tierNoticeDays', label: '分级预警：提示档（剩余天数≤）', defaultValue: 30, min: 0, max: 365 },
  tierWarningDays: { key: 'reminder.tierWarningDays', label: '分级预警：警告档（剩余天数≤）', defaultValue: 15, min: 0, max: 365 },
  tierUrgentDays: { key: 'reminder.tierUrgentDays', label: '分级预警：紧急档（剩余天数≤）', defaultValue: 7, min: 0, max: 365 },
  paymentGraceDays: { key: 'reminder.paymentGraceDays', label: '项目完成后多少天开始提醒待回款', defaultValue: 0, min: 0, max: 365 },
} as const;

export type ReminderConfigKey = keyof typeof REMINDER_CONFIG;

/** 分级预警档位（PRD 4.7「分级预警」） */
export const ALERT_LEVELS = ['OVERDUE', 'URGENT', 'WARNING', 'NOTICE', 'NORMAL'] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number];

/** 按剩余天数判定档位：已逾期最高，其次按紧急/警告/提示阈值逐级下降 */
function resolveAlertLevel(daysRemaining: number, thresholds: { urgent: number; warning: number; notice: number }) {
  if (daysRemaining < 0) return { level: 'OVERDUE' as AlertLevel, tierDays: null as number | null };
  if (daysRemaining <= thresholds.urgent) return { level: 'URGENT' as AlertLevel, tierDays: thresholds.urgent };
  if (daysRemaining <= thresholds.warning) return { level: 'WARNING' as AlertLevel, tierDays: thresholds.warning };
  if (daysRemaining <= thresholds.notice) return { level: 'NOTICE' as AlertLevel, tierDays: thresholds.notice };
  return { level: 'NORMAL' as AlertLevel, tierDays: null as number | null };
}

/** 合同/项目的结束状态：结束后不再产生新提醒 */
const CLOSED_CONTRACT_STATUSES = ['COMPLETED', 'TERMINATED'];
const CLOSED_PROJECT_STATUSES = ['COMPLETED', 'TERMINATED'];

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(value: Date) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * DAY_MS);
}

function toDateKey(value: Date) {
  return startOfDay(value).toISOString().slice(0, 10);
}

function thresholdsFor(config: Record<ReminderConfigKey, number>) {
  return { urgent: config.tierUrgentDays, warning: config.tierWarningDays, notice: config.tierNoticeDays };
}

/** 剩余天数：负数表示已逾期 */
function daysUntil(dueAt: Date, now: Date) {
  return Math.floor((startOfDay(dueAt).getTime() - startOfDay(now).getTime()) / DAY_MS);
}

@Injectable()
export class ReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReminderService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(ProjectAccessScopeService) private readonly projectAccess: ProjectAccessScopeService,
  ) {}

  /**
   * 计算某用户在提醒列表里**能看到哪些提醒**（PRD 4.6 / 4.7 的数据范围）。
   *
   * ## 业务口径（2026-10-14 确认）
   *
   * | 提醒类型 | 谁能看到 |
   * |---|---|
   * | 流程节点超期（项目级） | **项目负责人**，或**当前节点负责角色**的人 |
   * | 合同法定截止日 / 内部安全日 | 该合同的**负责销售** |
   * | 待回款合同 | 该合同的**负责销售**（与上一条一致） |
   * | dataScope = ALL（系统管理员 / 总经理） | 全部 |
   *
   * ## 为什么复用 ProjectAccessScopeService
   *
   * 它内部已经实现了「项目负责人 / 合同负责人 / 客户负责人 / 办过该项目的人 /
   * **当前节点负责角色**」这套判定（见 `relatedProjectConditions`）。
   * 提醒模块再写一套必然与项目、附件、回款等模块的口径分叉 ——
   * 所以这里只做"提醒类型 → 用哪种范围"的映射，判定本身完全复用。
   *
   * ## 为什么查询时过滤，而不是扫描时不生成
   *
   * 提醒**保持全局生成**：如果只给"当前该看的人"生成，那么项目换负责人、
   * 或某人的角色被调整时，历史提醒就丢了（新负责人看不到前任留下的超期）。
   * 显示侧过滤则随时跟得上：人员变动后看到的集合自动变化，数据不会丢。
   */
  private async buildVisibilityWhere(
    userId: string,
    dataScope: DataScope,
  ): Promise<Prisma.ReminderWhereInput> {
    if (dataScope === 'ALL') return {};
    if (dataScope === 'NONE') return { id: '__NO_ACCESS__' };

    const projectWhere = await this.projectAccess.buildProjectWhere(userId, dataScope);
    const visibleProjects = await this.prisma.project.findMany({ where: projectWhere, select: { id: true } });
    const projectIds = visibleProjects.map((item) => item.id);

    // 合同级提醒按"负责销售"判定（业务确认：法定截止日/内部安全日/待回款都归销售跟）
    const contractIds = (
      await this.prisma.contract.findMany({
        where: { deletedAt: null, ownerId: userId },
        select: { id: true },
      })
    ).map((item) => item.id);

    return {
      OR: [
        // 项目级提醒（节点超期）
        { AND: [{ type: ReminderType.NODE_OVERDUE }, { sourceId: { in: projectIds } }] },
        // 合同级提醒（法定截止日 / 内部安全日 / 待回款）
        {
          AND: [
            {
              type: {
                in: [
                  ReminderType.CONTRACT_DEADLINE,
                  ReminderType.INTERNAL_SAFETY,
                  ReminderType.PAYMENT_PENDING,
                ],
              },
            },
            { sourceId: { in: contractIds } },
          ],
        },
      ],
    };
  }

  async onModuleInit() {
    // 定时扫描：间隔由配置决定，0 表示关闭（验证脚本会关掉，避免后台任务干扰断言）
    const intervalMinutes = await this.readConfig('scanIntervalMinutes');
    if (intervalMinutes > 0) this.scheduleScan(intervalMinutes);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** 重设定时扫描（配置变更后调用） */
  async rescheduleScan() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const intervalMinutes = await this.readConfig('scanIntervalMinutes');
    if (intervalMinutes > 0) this.scheduleScan(intervalMinutes);
    return { intervalMinutes };
  }

  private scheduleScan(intervalMinutes: number) {
    this.timer = setInterval(() => {
      this.scan({ trigger: 'SCHEDULED' }).catch((error) => this.logger.warn(`定时扫描失败：${error.message}`));
    }, intervalMinutes * 60 * 1000);
    // 不阻塞进程退出
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.log(`提醒扫描已启用，每 ${intervalMinutes} 分钟一次`);
  }

  /* ---------------- 配置 ---------------- */

  async listConfig() {
    const rows = await this.prisma.systemConfig.findMany({ orderBy: { key: 'asc' } });
    const stored = new Map(rows.map((row) => [row.key, row]));

    return Object.entries(REMINDER_CONFIG).map(([name, definition]) => {
      const row = stored.get(definition.key);
      const parsed = row ? Number(row.value) : Number.NaN;
      return {
        name,
        key: definition.key,
        label: definition.label,
        value: Number.isFinite(parsed) ? parsed : definition.defaultValue,
        defaultValue: definition.defaultValue,
        min: definition.min,
        max: definition.max,
      };
    });
  }

  async readConfig(name: ReminderConfigKey): Promise<number> {
    const definition = REMINDER_CONFIG[name];
    const row = await this.prisma.systemConfig.findUnique({ where: { key: definition.key } });
    const parsed = row ? Number(row.value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : definition.defaultValue;
  }

  /** 批量读取，避免扫描时多次查库 */
  private async readAllConfig() {
    const entries = await Promise.all(
      (Object.keys(REMINDER_CONFIG) as ReminderConfigKey[]).map(async (name) => [name, await this.readConfig(name)] as const),
    );
    return Object.fromEntries(entries) as Record<ReminderConfigKey, number>;
  }

  async updateConfig(input: Record<string, number | undefined>, actorId?: string) {
    const changed: Array<{ name: string; from: number; to: number }> = [];

    for (const [name, value] of Object.entries(input)) {
      if (value === undefined) continue;
      const definition = REMINDER_CONFIG[name as ReminderConfigKey];
      if (!definition) throw new BadRequestException(`不支持的提醒参数：${name}`);
      const numeric = Number(value);
      if (!Number.isInteger(numeric) || numeric < definition.min || numeric > definition.max) {
        throw new BadRequestException(`「${definition.label}」必须是 ${definition.min}-${definition.max} 之间的整数`);
      }
      const before = await this.readConfig(name as ReminderConfigKey);
      await this.prisma.systemConfig.upsert({
        where: { key: definition.key },
        update: { value: String(numeric), label: definition.label },
        create: { key: definition.key, value: String(numeric), valueType: 'NUMBER', label: definition.label },
      });
      if (before !== numeric) changed.push({ name, from: before, to: numeric });
    }

    if (changed.length > 0) {
      await this.auditService.record({
        actorId,
        action: 'UPDATE',
        resourceType: 'ReminderConfig',
        reason: `提醒参数调整：${changed.map((item) => `${item.name} ${item.from}→${item.to}`).join('，')}`,
        afterData: { changed },
      });
      // 扫描间隔可能变化，立即生效
      if (changed.some((item) => item.name === 'scanIntervalMinutes')) await this.rescheduleScan();
    }
    return this.listConfig();
  }

  /* ---------------- 扫描 ---------------- */

  /**
   * 扫描并生成提醒。幂等：靠 dedupeKey 唯一约束，重复扫描不会产生重复提醒。
   * 触发时机：定时任务、进入提醒页、管理员手动触发。
   */
  async scan(options: { trigger?: 'SCHEDULED' | 'MANUAL' | 'ON_DEMAND'; actorId?: string } = {}) {
    const config = await this.readAllConfig();
    const now = new Date();
    let created = 0;
    let refreshed = 0;

    // 1. 合同：法定截止日 / 内部安全日 / 合同到期日
    const contracts = await this.prisma.contract.findMany({
      where: {
        deletedAt: null,
        statusCode: { notIn: CLOSED_CONTRACT_STATUSES },
        OR: [{ legallyDueAt: { not: null } }, { internalSafetyDate: { not: null } }, { expiryDate: { not: null } }],
      },
      select: {
        id: true,
        contractNo: true,
        legallyDueAt: true,
        internalSafetyDate: true,
        expiryDate: true,
        statusCode: true,
        customer: { select: { name: true } },
      },
    });

    for (const contract of contracts) {
      const customerName = contract.customer?.name ?? '未知客户';
      // 内部安全日：优先用填写的值，未填写时按「法定截止日 - 安全天数」推算
      const safetyDate =
        contract.internalSafetyDate ??
        (contract.legallyDueAt ? addDays(contract.legallyDueAt, -config.safetyMarginDays) : null);

      const targets: Array<{ type: ReminderType; dueAt: Date | null; title: string; detail: string; advanceDays: number; discriminator: string }> = [
        {
          type: ReminderType.CONTRACT_DEADLINE,
          dueAt: contract.legallyDueAt,
          title: `合同 ${contract.contractNo} 临近法定截止日`,
          detail: `客户：${customerName}`,
          advanceDays: config.contractAdvanceDays,
          discriminator: 'LEGAL',
        },
        {
          type: ReminderType.INTERNAL_SAFETY,
          dueAt: safetyDate,
          title: `合同 ${contract.contractNo} 临近内部安全日`,
          detail: `客户：${customerName}${contract.internalSafetyDate ? '' : `（按法定截止日提前 ${config.safetyMarginDays} 天推算）`}`,
          advanceDays: config.contractAdvanceDays,
          discriminator: 'SAFETY',
        },
      ];
      if (contract.expiryDate) {
        targets.push({
          type: ReminderType.CONTRACT_DEADLINE,
          dueAt: contract.expiryDate,
          title: `合同 ${contract.contractNo} 临近到期`,
          detail: `客户：${customerName}`,
          advanceDays: config.contractAdvanceDays,
          discriminator: 'EXPIRY',
        });
      }

      for (const target of targets) {
        if (!target.dueAt) continue;
        const result = await this.upsertReminder({
          type: target.type,
          sourceType: 'Contract',
          sourceId: contract.id,
          sourceNo: contract.contractNo,
          title: target.title,
          detail: target.detail,
          dueAt: target.dueAt,
          advanceDays: target.advanceDays,
          // 同一合同的法定截止日、内部安全日、到期日各算一条，用 discriminator 区分
          discriminator: target.discriminator,
          thresholds: thresholdsFor(config),
          now,
        });
        if (result === 'created') created += 1;
        else if (result === 'refreshed') refreshed += 1;
      }
    }

    // 2. 项目：当前节点超期（按节点时限与进入时间判断）
    const projects = await this.prisma.project.findMany({
      where: {
        deletedAt: null,
        statusCode: { notIn: CLOSED_PROJECT_STATUSES },
        currentNodeCode: { not: null },
        workflowVersionId: { not: null },
        // 合同已完成/已终止时，其下项目不必再催节点：合同都结了还提醒节点超期是噪音
        contract: { deletedAt: null, statusCode: { notIn: CLOSED_CONTRACT_STATUSES } },
      },
      select: {
        id: true,
        projectNo: true,
        projectName: true,
        currentNodeCode: true,
        currentNodeEnteredAt: true,
        statusCode: true,
        workflowVersion: { select: { nodes: { select: { code: true, name: true, deadlineDays: true } } } },
      },
    });

    for (const project of projects) {
      const node = project.workflowVersion?.nodes.find((item) => item.code === project.currentNodeCode);
      if (!node?.deadlineDays || !project.currentNodeEnteredAt) continue;

      const dueAt = addDays(project.currentNodeEnteredAt, node.deadlineDays);
      const result = await this.upsertReminder({
        type: ReminderType.NODE_OVERDUE,
        sourceType: 'Project',
        sourceId: project.id,
        sourceNo: project.projectNo,
        title: `项目 ${project.projectNo} 节点「${node.name}」临近/超过时限`,
        detail: `项目名称：${project.projectName}；节点时限 ${node.deadlineDays} 天`,
        dueAt,
        advanceDays: config.nodeAdvanceDays,
        // 节点编码作为区分标记：同一项目换到别的节点后是另一条提醒
        discriminator: project.currentNodeCode ?? 'NODE',
        thresholds: thresholdsFor(config),
        now,
      });
      if (result === 'created') created += 1;
      else if (result === 'refreshed') refreshed += 1;
    }

    // 3. 待回款合同（PRD 4.10：合同完成条件固定为「项目全部走完 + 钱全部到账」）
    //    判定：项目已全部走完但已收款 < 合同金额 → 提醒催款
    const paymentCandidates = await this.prisma.contract.findMany({
      where: {
        deletedAt: null,
        statusCode: { notIn: CLOSED_CONTRACT_STATUSES },
        projects: { some: { deletedAt: null } },
      },
      select: {
        id: true,
        contractNo: true,
        amount: true,
        customer: { select: { name: true } },
        projects: { where: { deletedAt: null }, select: { id: true, statusCode: true } },
        paymentAllocations: { where: { payment: { deletedAt: null } }, select: { amount: true } },
      },
    });

    for (const contract of paymentCandidates) {
      const allProjectsDone = contract.projects.every((project) => CLOSED_PROJECT_STATUSES.includes(project.statusCode));
      if (!allProjectsDone) continue;

      const collected = contract.paymentAllocations.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
      const outstanding = contract.amount.minus(collected);
      if (outstanding.lessThanOrEqualTo(0)) continue; // 钱已全部到账，合同达成完成条件

      // 起算点：最后一个项目的完成时间（查不到时退回合同更新时间）
      const lastCompletion = await this.prisma.statusChangeHistory.findFirst({
        where: {
          resourceType: 'Project',
          resourceId: { in: contract.projects.map((project) => project.id) },
          toStatusCode: { in: CLOSED_PROJECT_STATUSES },
        },
        orderBy: { changedAt: 'desc' },
        select: { changedAt: true },
      });
      const baseAt = lastCompletion?.changedAt ?? new Date();
      const dueAt = addDays(baseAt, config.paymentGraceDays);

      const result = await this.upsertReminder({
        type: ReminderType.PAYMENT_PENDING,
        sourceType: 'Contract',
        sourceId: contract.id,
        sourceNo: contract.contractNo,
        title: `合同 ${contract.contractNo} 待回款 ¥${outstanding.toFixed(2)}`,
        detail: `客户：${contract.customer?.name ?? '未知客户'}；项目已全部走完，已收 ¥${collected.toFixed(2)} / 合同金额 ¥${contract.amount.toFixed(2)}`,
        dueAt,
        advanceDays: config.contractAdvanceDays,
        // 同一合同的待回款提醒只保留一条；金额变化时就地更新
        discriminator: 'PAYMENT',
        thresholds: thresholdsFor(config),
        now,
      });
      if (result === 'created') created += 1;
      else if (result === 'refreshed') refreshed += 1;
    }

    // 4. 清理：已处理/已结束的提醒超过保留周期后删除
    const cleaned = await this.cleanup(config.retentionDays, now);

    const unhandled = await this.prisma.reminder.count({ where: { isHandled: false } });
    return {
      trigger: options.trigger ?? 'MANUAL',
      scannedAt: now,
      contracts: contracts.length,
      projects: projects.length,
      created,
      refreshed,
      cleaned,
      unhandled,
    };
  }

  /**
   * 写入或刷新一条提醒。
   * - 同一对象+类型+区分标记已有**未处理**提醒：就地更新到期日与预警档位（改期不该产生第二条提醒）
   * - 已存在的**已处理**提醒：不动它，改期后按新到期日生成一条新的（视为新问题）
   * - 未到提前提醒窗口：不生成
   */
  private async upsertReminder(input: {
    type: ReminderType;
    sourceType: string;
    sourceId: string;
    sourceNo: string;
    title: string;
    detail: string;
    dueAt: Date;
    advanceDays: number;
    /** 同一对象同一类型下用于区分多条提醒的标记，如 LEGAL / SAFETY / EXPIRY 或节点编码 */
    discriminator: string;
    now: Date;
    /** 分级预警阈值（PRD 4.7） */
    thresholds?: { urgent: number; warning: number; notice: number };
  }): Promise<'created' | 'refreshed' | 'skipped'> {
    const dedupeKey = `${input.sourceType.toUpperCase()}:${input.sourceId}:${input.type}:${input.discriminator}:${toDateKey(input.dueAt)}`;
    const triggerAt = addDays(input.dueAt, -input.advanceDays);
    const overdueDays = Math.max(0, daysUntil(input.dueAt, input.now) * -1);
    const isOverdue = startOfDay(input.dueAt).getTime() < startOfDay(input.now).getTime();
    const daysRemaining = daysUntil(input.dueAt, input.now);
    const tier = resolveAlertLevel(daysRemaining, input.thresholds ?? { urgent: 7, warning: 15, notice: 30 });

    // 先按业务维度找未处理的同源提醒：到期日改期时更新这一条，而不是再生成一条
    const existingUnhandled = await this.prisma.reminder.findFirst({
      where: { sourceType: input.sourceType, sourceId: input.sourceId, type: input.type, dedupeKey: { startsWith: `${input.sourceType.toUpperCase()}:${input.sourceId}:${input.type}:${input.discriminator}:` }, isHandled: false },
    });

    if (existingUnhandled) {
      await this.prisma.reminder.update({
        where: { id: existingUnhandled.id },
        data: {
          dueAt: input.dueAt,
          triggerAt,
          overdueDays,
          detail: input.detail,
          title: input.title,
          sourceNo: input.sourceNo,
          dedupeKey,
          alertLevel: tier.level,
          tierDays: tier.tierDays,
        },
      });
      return existingUnhandled.dedupeKey === dedupeKey ? 'refreshed' : 'created';
    }

    // 已处理的同源提醒保持已处理状态，改期后视为新问题另生成一条
    const existingHandled = await this.prisma.reminder.findUnique({ where: { dedupeKey } });
    if (existingHandled) return 'skipped';

    // 未到提前提醒窗口，先不生成（超过提示档说明还早）
    const windowDays = Math.max(input.advanceDays, tier.tierDays ?? 0);
    if (!isOverdue && startOfDay(triggerAt).getTime() > startOfDay(input.now).getTime() && daysRemaining > windowDays) return 'skipped';

    await this.prisma.reminder.create({
      data: {
        type: input.type,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceNo: input.sourceNo,
        title: input.title,
        detail: input.detail,
        triggerAt,
        dueAt: input.dueAt,
        overdueDays,
        dedupeKey,
        alertLevel: tier.level,
        tierDays: tier.tierDays,
      },
    });
    return 'created';
  }

  /** 清理超过保留周期的已处理提醒，以及提醒对象已不存在的孤儿提醒 */
  private async cleanup(retentionDays: number, now: Date) {
    const threshold = addDays(now, -retentionDays);
    const removed = await this.prisma.reminder.deleteMany({
      where: {
        OR: [
          { isHandled: true, handledAt: { lt: threshold } },
          { isSourceClosed: true, updatedAt: { lt: threshold } },
        ],
      },
    });
    return removed.count;
  }

  /* ---------------- 查询与处理 ---------------- */

  async list(
    query: {
      isHandled?: 'true' | 'false';
      type?: ReminderType;
      sourceType?: string;
      page?: number;
      pageSize?: number;
      /** 进入提醒页时先扫描一次，保证数据新鲜；默认开启 */
      scan?: string;
    },
    /** 当前登录人与其数据范围：决定这个人能看到哪些提醒（PRD 第 3 章数据权限） */
    viewer?: { userId: string; dataScope: DataScope },
  ) {
    // 进入页面时按需扫描（幂等，不会产生重复）
    if (query.scan !== 'false') await this.scan({ trigger: 'ON_DEMAND' });

    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    // 可见性过滤：不传 viewer 时按"看全部"处理（供定时任务等内部调用）
    const visibility = viewer ? await this.buildVisibilityWhere(viewer.userId, viewer.dataScope) : {};
    const where: Prisma.ReminderWhereInput = {
      AND: [
        visibility,
        {
          ...(query.isHandled === 'true' ? { isHandled: true } : {}),
          ...(query.isHandled === 'false' ? { isHandled: false } : {}),
          ...(query.type ? { type: query.type } : {}),
          ...(query.sourceType ? { sourceType: query.sourceType } : {}),
        },
      ],
    };

    const [items, total, unhandled, overdue, handled] = await this.prisma.$transaction([
      this.prisma.reminder.findMany({
        where,
        orderBy: [{ isHandled: 'asc' }, { dueAt: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { handledBy: { select: { id: true, displayName: true } } },
      }),
      this.prisma.reminder.count({ where }),
      this.prisma.reminder.count({ where: { AND: [visibility, { isHandled: false }] } }),
      this.prisma.reminder.count({ where: { AND: [visibility, { isHandled: false, overdueDays: { gt: 0 } }] } }),
      // 已处理数必须独立统计：不能用「total - unhandled」——
      // total 是**按当前筛选**统计的（默认只数未处理），相减只会得到 0 或负数（曾显示为「已处理 -14」）。
      // 同样要带可见性过滤，否则销售会看到"已处理"里混着别人的单子。
      this.prisma.reminder.count({ where: { AND: [visibility, { isHandled: true }] } }),
    ]);

    const now = new Date();
    return {
      items: items.map((item) => ({
        ...item,
        daysRemaining: daysUntil(item.dueAt, now),
        isOverdue: item.overdueDays > 0,
      })),
      total,
      page,
      pageSize,
      summary: { unhandled, overdue, handled },
    };
  }

  /**
   * PRD 第十章「卡片四：待办提醒」口径的看板数据。
   *
   * | PRD 卡片项 | 本系统口径 |
   * |---|---|
   * | 今日待办 | 今天到期或已逾期且未处理的提醒 |
   * | 逾期项目 | 节点超期未处理的项目（去重） |
   * | 超时邮件登记 | 需邮件送达=true 且尚未登记任何有效送达记录的官文 |
   * | 待回款合同 | 项目已全部走完但款项未收齐的合同 |
   */
  async prdSummary(viewer?: { userId: string; dataScope: DataScope }) {
    const now = new Date();
    const startOfToday = startOfDay(now);
    const endOfToday = new Date(startOfToday.getTime() + DAY_MS - 1);

    // 首页 4 张卡片同样按角色收窄（业务确认 2026-10-14）：
    // 销售只看到自己名下的待办，管理员/总经理（dataScope=ALL）看全局。
    // 否则首页会变成"全局概览"，销售能读到不属于自己的业务量。
    const visibility = viewer ? await this.buildVisibilityWhere(viewer.userId, viewer.dataScope) : {};
    // 「超时邮件登记」不是提醒表，而是按官文实时算的，因此要单独算可见项目范围
    const visibleProjectIds =
      viewer && viewer.dataScope !== 'ALL'
        ? viewer.dataScope === 'NONE'
          ? []
          : (
              await this.prisma.project.findMany({
                where: await this.projectAccess.buildProjectWhere(viewer.userId, viewer.dataScope),
                select: { id: true },
              })
            ).map((item) => item.id)
        : null;

    const [todayTodo, overdueNodeGroups, overdueMailRegistrations, paymentPending, unhandled, overdue] = await this.prisma.$transaction([
      this.prisma.reminder.count({
        where: { AND: [visibility, { isHandled: false, dueAt: { lte: endOfToday } }] },
      }),
      this.prisma.reminder.groupBy({
        by: ['sourceId'],
        where: { AND: [visibility, { isHandled: false, type: ReminderType.NODE_OVERDUE, overdueDays: { gt: 0 } }] },
        orderBy: { sourceId: 'asc' },
      }),
      this.prisma.officialDocument.count({
        where: {
          deletedAt: null,
          needsMailDelivery: true,
          mailDeliveries: { none: { deletedAt: null } },
          project: {
            deletedAt: null,
            // visibleProjectIds 为 null 表示"看全部"；为数组时限定在这些项目内
            ...(visibleProjectIds === null ? {} : { id: { in: visibleProjectIds } }),
          },
        },
      }),
      this.prisma.reminder.count({
        where: { AND: [visibility, { isHandled: false, type: ReminderType.PAYMENT_PENDING }] },
      }),
      this.prisma.reminder.count({ where: { AND: [visibility, { isHandled: false }] } }),
      this.prisma.reminder.count({ where: { AND: [visibility, { isHandled: false, overdueDays: { gt: 0 } }] } }),
    ]);

    return {
      // PRD 第十一章线框图里的四项
      todayTodo,
      overdueProjects: overdueNodeGroups.length,
      overdueMailRegistrations,
      paymentPendingContracts: paymentPending,
      // 总体
      unhandled,
      overdue,
      unavailable: [],
    };
  }

  /**
   * 校验操作人**有权看到**这条提醒，看不到就不允许处理。
   *
   * 为什么需要：`handle` / `unhandle` 本来只按 id 查了就改，没有任何范围校验。
   * 目前只有系统管理员与总经理持有 `reminder.handle`（dataScope 均为 ALL），
   * 所以尚未造成越权；但一旦给"分下去的人员"授予处理权限，
   * A 就能把 B 的提醒标记为已处理 —— 被标记后 B 在列表里就看不到了（等于把别人的待办抹掉）。
   *
   * 这里做的是防御性校验：现在不改变任何行为（ALL 直接放行），
   * 将来下放处理权限时自动安全。
   */
  private async assertVisible(reminderId: string, userId: string, dataScope: DataScope) {
    if (dataScope === 'ALL') return;
    const visibility = await this.buildVisibilityWhere(userId, dataScope);
    const visible = await this.prisma.reminder.findFirst({
      where: { AND: [{ id: reminderId }, visibility] },
      select: { id: true },
    });
    if (!visible) throw new ForbiddenException('该提醒不在你的负责范围内，无法处理');
  }

  /** 标记为已处理 */
  async handle(id: string, input: { note?: string }, actorId: string, dataScope: DataScope = 'ALL') {
    const reminder = await this.prisma.reminder.findUnique({ where: { id } });
    if (!reminder) throw new NotFoundException('提醒不存在');
    if (reminder.isHandled) throw new BadRequestException('该提醒已处理，无需重复操作');
    await this.assertVisible(id, actorId, dataScope);

    const updated = await this.prisma.reminder.update({
      where: { id },
      data: { isHandled: true, handledAt: new Date(), handledById: actorId, handleNote: input.note ?? null },
      include: { handledBy: { select: { id: true, displayName: true } } },
    });
    await this.auditService.record({
      actorId,
      action: 'HANDLE_REMINDER',
      resourceType: 'Reminder',
      resourceId: id,
      reason: input.note ?? `处理提醒：${reminder.title}`,
      beforeData: { isHandled: false },
      afterData: { isHandled: true },
    });
    return updated;
  }

  /** 取消处理（误点恢复） */
  async unhandle(id: string, actorId: string, dataScope: DataScope = 'ALL') {
    const reminder = await this.prisma.reminder.findUnique({ where: { id } });
    if (!reminder) throw new NotFoundException('提醒不存在');
    if (!reminder.isHandled) throw new BadRequestException('该提醒尚未处理');
    await this.assertVisible(id, actorId, dataScope);

    const updated = await this.prisma.reminder.update({
      where: { id },
      data: { isHandled: false, handledAt: null, handledById: null, handleNote: null },
    });
    await this.auditService.record({
      actorId,
      action: 'UNHANDLE_REMINDER',
      resourceType: 'Reminder',
      resourceId: id,
      reason: `取消处理提醒：${reminder.title}`,
    });
    return updated;
  }
}



