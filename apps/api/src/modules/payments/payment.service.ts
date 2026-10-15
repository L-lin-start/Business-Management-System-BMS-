import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataScope, Prisma } from '@prisma/client';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { DOCUMENT_NUMBER_PREFIX, DocumentNumberService } from '../../infrastructure/document-number/document-number.service';
import { parseCalendarDate } from '../../infrastructure/date/calendar-date';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { CreatePaymentDto, PaymentQueryDto, UpdatePaymentDto } from './dto/payment.dto';
import { ContractStatusService } from '../contracts/contract-status.service';
import { ProjectAccessScopeService } from '../../infrastructure/project-access/project-access-scope.service';

const PAYMENT_INCLUDE = {
  contract: { select: { id: true, contractNo: true, customer: { select: { id: true, name: true } } } },
  contractAllocations: {
    include: { contract: { select: { id: true, contractNo: true, customer: { select: { id: true, name: true } } } } },
  },
  allocations: {
    include: { project: { select: { id: true, projectNo: true, projectName: true } } },
    orderBy: { project: { sequence: 'asc' as const } },
  },
} satisfies Prisma.PaymentReceiptInclude;

/**
 * 回款：收款单可以对应多个合同，并可继续分摊到多个项目。
 * 合同已收款 = 合同分配金额之和；项目回款 = 项目分配金额之和。
 */
/**
 * 排除「所属合同已删除」的回款（业务决定 2026-10-14）。
 *
 * ## 为什么需要这个条件
 *
 * 删除合同时**不回滚回款**（回款是合同层面的钱、已分摊到项目，回滚会破坏分摊一致性），
 * 所以那些回款行仍然有效。但业务上它们**不应再计入已收款** ——
 * 看板已经在 `contract.deletedAt: null` 上过滤了，这里必须跟上，
 * 否则「看板已收款」与「回款列表合计」会出现两个数。
 *
 * `legacy` 的 `contractId` 是可空的（跨合同回款时为空），因此只在非空时比较。
 */
const EXCLUDE_DELETED_CONTRACT = {
  OR: [{ contractId: null }, { contract: { deletedAt: null } }],
} satisfies Prisma.PaymentReceiptWhereInput;

@Injectable()
export class PaymentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(DocumentNumberService) private readonly documentNumber: DocumentNumberService,
    @Inject(ContractStatusService) private readonly contractStatusService: ContractStatusService,
    @Inject(ProjectAccessScopeService) private readonly projectAccess: ProjectAccessScopeService,
  ) {}

  async list(query: PaymentQueryDto, userId: string, dataScope: DataScope) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const where: Prisma.PaymentReceiptWhereInput = {
      deletedAt: null,
      // 数据范围与业务筛选必须用 AND 组合。
      //
      // 事故背景：这里原本是 `{ ...(await this.buildScopeWhere()), ...(query.contractId ? { OR: [...] } : {}) }`，
      // 而 `buildScopeWhere()` 自身返回 `{ OR: [...] }`。JS 展开同名的 `OR` 会**后者覆盖前者**，
      // 于是传入 `contractId` 时数据范围过滤被整个丢掉 —— 销售A 只要带上别人的 contractId，
      // 就能查到不属于自己的回款（已实测复现）。改成 AND 后两者同时生效。
      AND: [
        await this.buildScopeWhere(userId, dataScope),
        // 所属合同已删除的回款默认不显示（与看板口径一致）
        EXCLUDE_DELETED_CONTRACT,
        {
          ...(query.contractId
            ? { OR: [{ contractId: query.contractId }, { contractAllocations: { some: { contractId: query.contractId } } }] }
            : {}),
          ...(query.projectId ? { allocations: { some: { projectId: query.projectId } } } : {}),
          ...(query.keyword ? { receiptNo: { contains: query.keyword, mode: 'insensitive' } } : {}),
        },
      ],
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.paymentReceipt.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: PAYMENT_INCLUDE,
      }),
      this.prisma.paymentReceipt.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async getById(id: string, userId: string, dataScope: DataScope) {
    const payment = await this.prisma.paymentReceipt.findFirst({
      where: { id, deletedAt: null, ...(await this.buildScopeWhere(userId, dataScope)) },
      include: PAYMENT_INCLUDE,
    });
    if (!payment) throw new NotFoundException('回款不存在或无权查看');
    return payment;
  }

  async create(input: CreatePaymentDto, actorId: string, dataScope: DataScope = 'ALL') {
    const normalized = await this.normalizeAllocations(input, actorId, dataScope);
    this.assertNoUnconfirmedOverpay(normalized.overpays, input.confirmOverpay);

    const receiptNo = await this.documentNumber.allocate({
      scope: 'payment',
      prefix: DOCUMENT_NUMBER_PREFIX.payment,
      year: this.documentNumber.resolveYear(input.receivedAt),
      isAvailable: async (value) => (await this.prisma.paymentReceipt.count({ where: { receiptNo: value } })) === 0,
    });

    const payment = await this.prisma.paymentReceipt.create({
      data: {
        receiptNo: receiptNo.value,
        contractId: normalized.legacyContractId,
        amount: input.amount,
        receivedAt: parseCalendarDate(input.receivedAt) ?? new Date(),
        paymentMethod: input.paymentMethod ?? null,
        note: input.note ?? null,
        ...(input.customFields ? { customFields: input.customFields as Prisma.InputJsonValue } : {}),
        contractAllocations: { create: normalized.contractAllocations },
        ...(normalized.projectAllocations.length > 0
          ? { allocations: { create: normalized.projectAllocations } }
          : {}),
      },
      include: PAYMENT_INCLUDE,
    });
    await this.auditService.record({ actorId, action: 'CREATE', resourceType: 'PaymentReceipt', resourceId: payment.id, afterData: payment });
    await this.reconcileContracts(normalized.contractAllocations.map((item) => item.contractId), actorId, '新增回款后自动同步合同状态');
    return payment;
  }

  async update(id: string, input: UpdatePaymentDto, actorId: string, dataScope: DataScope) {
    const before = await this.getEditable(id, actorId, dataScope);
    // 编辑时排除自己原有的金额，否则会把旧值重复计入已收款而误判超收
    const normalized = await this.normalizeAllocations(input, actorId, dataScope, id);
    this.assertNoUnconfirmedOverpay(normalized.overpays, input.confirmOverpay);
    const previousAllocations = await this.prisma.paymentContractAllocation.findMany({ where: { paymentId: id }, select: { contractId: true } });
    const affectedContractIds = new Set<string>([
      ...(before.contractId ? [before.contractId] : []),
      ...previousAllocations.map((item) => item.contractId),
      ...normalized.contractAllocations.map((item) => item.contractId),
    ]);

    const payment = await this.prisma.$transaction(async (tx) => {
      await tx.projectPaymentAllocation.deleteMany({ where: { paymentId: id } });
      await tx.paymentContractAllocation.deleteMany({ where: { paymentId: id } });
      return tx.paymentReceipt.update({
        where: { id },
        data: {
          contractId: normalized.legacyContractId,
          amount: input.amount,
          receivedAt: parseCalendarDate(input.receivedAt) ?? new Date(),
          paymentMethod: input.paymentMethod ?? null,
          note: input.note ?? null,
          ...(input.customFields ? { customFields: input.customFields as Prisma.InputJsonValue } : {}),
          contractAllocations: { create: normalized.contractAllocations },
          ...(normalized.projectAllocations.length > 0
            ? { allocations: { create: normalized.projectAllocations } }
            : {}),
        },
        include: PAYMENT_INCLUDE,
      });
    });
    await this.auditService.record({ actorId, action: 'UPDATE', resourceType: 'PaymentReceipt', resourceId: id, beforeData: before, afterData: payment });
    await this.reconcileContracts([...affectedContractIds], actorId, '修改回款后自动同步合同状态');
    return payment;
  }

  /** 软删除回款（PRD 7.2）：必须填原因并落库；删除后同步重算受影响合同的状态 */
  async softDelete(id: string, actorId: string, dataScope: DataScope, reason?: string) {
    const trimmed = reason?.trim();
    if (!trimmed) throw new BadRequestException('请填写删除原因');

    const before = await this.getEditable(id, actorId, dataScope);
    const allocations = await this.prisma.paymentContractAllocation.findMany({ where: { paymentId: id }, select: { contractId: true } });
    const affectedContractIds = new Set<string>([
      ...(before.contractId ? [before.contractId] : []),
      ...allocations.map((item) => item.contractId),
    ]);
    const payment = await this.prisma.paymentReceipt.update({
      where: { id },
      data: { deletedAt: new Date(), deleteReason: trimmed, deletedBy: actorId },
    });
    await this.auditService.record({
      actorId,
      action: 'SOFT_DELETE',
      resourceType: 'PaymentReceipt',
      resourceId: id,
      reason: trimmed,
      beforeData: before,
      afterData: { deletedAt: payment.deletedAt, deleteReason: payment.deleteReason },
    });
    await this.reconcileContracts([...affectedContractIds], actorId, '删除回款后自动同步合同状态');
    return { id, deletedAt: payment.deletedAt };
  }

  /** 恢复被软删除的回款（PRD 7.1，仅管理员）；恢复后同样重算合同状态 */
  async restore(id: string, actorId: string, reason?: string) {
    const payment = await this.prisma.paymentReceipt.findFirst({ where: { id, deletedAt: { not: null } } });
    if (!payment) throw new NotFoundException('该回款不在已删除状态，无需恢复');
    const allocations = await this.prisma.paymentContractAllocation.findMany({ where: { paymentId: id }, select: { contractId: true } });
    const affectedContractIds = [...new Set([payment.contractId, ...allocations.map((item) => item.contractId)].filter((x): x is string => Boolean(x)))];

    await this.prisma.paymentReceipt.update({ where: { id }, data: { deletedAt: null, deleteReason: null, deletedBy: null } });
    await this.auditService.record({
      actorId,
      action: 'RESTORE',
      resourceType: 'PaymentReceipt',
      resourceId: id,
      reason: reason?.trim() || '管理员恢复已删除的回款',
      beforeData: { deletedAt: payment.deletedAt, deleteReason: payment.deleteReason },
      afterData: { deletedAt: null },
    });
    await this.reconcileContracts(affectedContractIds, actorId, '恢复回款后自动同步合同状态');
    return { id, restored: true };
  }

  private async reconcileContracts(contractIds: string[], actorId: string, reason: string) {
    for (const contractId of new Set(contractIds)) {
      await this.contractStatusService.reconcile(contractId, actorId, reason);
    }
  }

  /**
   * 统一校验合同分配和项目分配。
   * 旧客户端只传 contractId 时按整笔回款分配给该合同；新客户端可传多个合同。
   * 项目分配可以为空，表示只登记合同级回款；如填写，项目所属合同必须有对应分配。
   */
  /**
   * 超额收款的二次确认门槛。
   *
   * 业务确认（2026-10-14）：**允许超收**（预收款、多期款、先收款后补签协议都属正常），
   * 但不能悄悄收超 —— 必须让操作人看见「本次将超收多少」并明确确认。
   *
   * 因此这里返回 409 + 可识别错误码：
   * 前端识别到 `OVERPAY_CONFIRMATION_REQUIRED` 后弹确认框，
   * 用户确认再带 `confirmOverpay: true` 重提。
   */
  private assertNoUnconfirmedOverpay(
    overpays: Array<{ contractId: string; contractNo: string; overAmount: number; receivable: number; collected: number }>,
    confirmed?: boolean,
  ) {
    if (confirmed || overpays.length === 0) return;
    const detail = overpays
      .map(
        (item) =>
          `合同 ${item.contractNo}：应收净额 ¥${item.receivable.toFixed(2)}、已收 ¥${item.collected.toFixed(2)}，本次将超收 ¥${item.overAmount.toFixed(2)}`,
      )
      .join('；');
    throw new ConflictException({
      statusCode: 409,
      code: 'OVERPAY_CONFIRMATION_REQUIRED',
      message: `本次回款将超出合同应收金额，请确认是否继续。${detail}`,
      overpays,
    });
  }

  private async normalizeAllocations(input: CreatePaymentDto, actorId?: string, dataScope: DataScope = 'ALL', excludingPaymentId?: string) {
    const projectAllocations = input.allocations ?? [];
    const projectIds = projectAllocations.map((item) => item.projectId);
    if (new Set(projectIds).size !== projectIds.length) throw new BadRequestException('同一项目不能重复分摊');
    const projectTotal = projectAllocations.reduce((sum, item) => sum + Number(item.amount), 0);
    if (projectTotal > Number(input.amount) + 0.005) throw new BadRequestException('项目分摊金额不能超过回款总额');

    const projects = projectIds.length === 0
      ? []
      : await this.prisma.project.findMany({
          where: { id: { in: projectIds }, deletedAt: null },
          select: { id: true, contractId: true },
        });
    if (projects.length !== projectIds.length) throw new BadRequestException('存在无效或已删除的项目');
    if (actorId) {
      for (const project of projects) await this.projectAccess.assertProjectAccess(project.id, actorId, dataScope);
    }

    const projectContractById = new Map(projects.map((item) => [item.id, item.contractId]));
    const projectTotalsByContract = new Map<string, number>();
    for (const allocation of projectAllocations) {
      const contractId = projectContractById.get(allocation.projectId)!;
      projectTotalsByContract.set(contractId, (projectTotalsByContract.get(contractId) ?? 0) + Number(allocation.amount));
    }

    let contractAllocations = input.contractAllocations?.map((item) => ({ contractId: item.contractId, amount: Number(item.amount) })) ?? [];
    if (contractAllocations.length === 0) {
      if (projectTotalsByContract.size > 0) {
        contractAllocations = [...projectTotalsByContract.entries()].map(([contractId, amount]) => ({ contractId, amount }));
        const unallocated = Number(input.amount) - projectTotal;
        if (contractAllocations.length === 1 && unallocated > 0.005) contractAllocations[0]!.amount += unallocated;
      } else if (input.contractId) {
        contractAllocations = [{ contractId: input.contractId, amount: Number(input.amount) }];
      } else {
        throw new BadRequestException('请至少指定一个所属合同');
      }
    }

    if (new Set(contractAllocations.map((item) => item.contractId)).size !== contractAllocations.length) {
      throw new BadRequestException('同一合同不能重复分配，请合并金额');
    }
    const contractTotal = contractAllocations.reduce((sum, item) => sum + item.amount, 0);
    if (Math.abs(contractTotal - Number(input.amount)) > 0.005) throw new BadRequestException('合同分配金额合计必须等于回款总额');
    const contracts = await this.prisma.contract.findMany({
      where: { id: { in: contractAllocations.map((item) => item.contractId) }, deletedAt: null },
      select: { id: true, contractNo: true, amount: true },
    });
    if (contracts.length !== contractAllocations.length) throw new NotFoundException('存在无效或已删除的所属合同');
    if (actorId) {
      for (const contract of contracts) await this.projectAccess.assertContractAccess(contract.id, actorId, dataScope);
    }
    for (const [contractId, projectTotalForContract] of projectTotalsByContract) {
      const contractAllocation = contractAllocations.find((item) => item.contractId === contractId);
      if (!contractAllocation || projectTotalForContract > contractAllocation.amount + 0.005) {
        throw new BadRequestException('项目分摊金额不能超过其所属合同分配金额');
      }
    }

    // 超额收款检测（业务确认 2026-10-14：允许超收，但必须二次确认）。
    // 口径：合同应收净额 = 合同金额 − 累计金额调整额；已收 + 本次 > 应收净额即为超收。
    const overpays: Array<{ contractId: string; contractNo: string; overAmount: number; receivable: number; collected: number }> = [];
    const adjustmentRows = await this.prisma.contractAmountAdjustment.findMany({
      where: { contractId: { in: contractAllocations.map((item) => item.contractId) }, deletedAt: null },
      select: { contractId: true, amount: true },
    });
    const adjustmentByContract = new Map<string, number>();
    for (const row of adjustmentRows) {
      adjustmentByContract.set(row.contractId, (adjustmentByContract.get(row.contractId) ?? 0) + Number(row.amount));
    }
    for (const allocation of contractAllocations) {
      const contract = contracts.find((item) => item.id === allocation.contractId);
      if (!contract) continue;
      const collectedAmount = await this.sumCollectedAmount(contract.id, excludingPaymentId);
      const adjusted = adjustmentByContract.get(contract.id) ?? 0;
      const receivable = Number(contract.amount) - adjusted;
      const afterThis = collectedAmount + allocation.amount;
      if (afterThis > receivable + 0.005) {
        overpays.push({
          contractId: contract.id,
          contractNo: contract.contractNo,
          overAmount: Number((afterThis - receivable).toFixed(2)),
          receivable: Number(receivable.toFixed(2)),
          collected: Number(collectedAmount.toFixed(2)),
        });
      }
    }

    return {
      legacyContractId: contractAllocations.length === 1 ? contractAllocations[0]!.contractId : null,
      contractAllocations,
      projectAllocations,
      overpays,
    };
  }

  /**
   * 某合同当前的有效已收款合计。
   *
   * 口径与合同详情一致：优先取合同维度分摊（`PaymentContractAllocation`），
   * 再补上只挂在合同上、没有分摊记录的旧数据（`PaymentReceipt.contractId`）。
   *
   * @param excludingPaymentId 编辑回款时排除自己，避免把自己的旧金额重复计入
   */
  private async sumCollectedAmount(contractId: string, excludingPaymentId?: string): Promise<number> {
    const [allocations, legacyReceipts] = await Promise.all([
      this.prisma.paymentContractAllocation.findMany({
        where: { contractId, payment: { deletedAt: null, ...(excludingPaymentId ? { id: { not: excludingPaymentId } } : {}) } },
        select: { amount: true },
      }),
      this.prisma.paymentReceipt.findMany({
        where: {
          contractId,
          deletedAt: null,
          contractAllocations: { none: {} },
          ...(excludingPaymentId ? { id: { not: excludingPaymentId } } : {}),
        },
        select: { amount: true },
      }),
    ]);
    return [...allocations, ...legacyReceipts].reduce((sum, item) => sum + Number(item.amount), 0);
  }

  private async getEditable(id: string, userId: string, dataScope: DataScope) {
    const payment = await this.prisma.paymentReceipt.findFirst({ where: { id, deletedAt: null, ...(await this.buildScopeWhere(userId, dataScope)) } });
    if (!payment) throw new NotFoundException('回款不存在或无权操作');
    return payment;
  }

  /**
   * 导出的过滤条件（PRD 4.12）。
   * 复用列表用的 `buildScopeWhere`，与列表口径完全一致，避免导出越权。
   */
  async buildExportWhere(query: PaymentQueryDto, userId: string, dataScope: DataScope): Promise<Prisma.PaymentReceiptWhereInput> {
    return {
      deletedAt: null,
      // 与 list() 同样的 AND 组合，避免 OR 覆盖导致越权（详见 list() 的注释）
      AND: [
        await this.buildScopeWhere(userId, dataScope),
        // 与列表、看板一致：所属合同已删除的回款不导出
        EXCLUDE_DELETED_CONTRACT,
        {
          ...(query.contractId
            ? { OR: [{ contractId: query.contractId }, { contractAllocations: { some: { contractId: query.contractId } } }] }
            : {}),
          ...(query.projectId ? { allocations: { some: { projectId: query.projectId } } } : {}),
          ...(query.keyword ? { receiptNo: { contains: query.keyword, mode: 'insensitive' } } : {}),
        },
      ],
    };
  }

  private async buildScopeWhere(userId: string, dataScope: DataScope): Promise<Prisma.PaymentReceiptWhereInput> {
    const contractWhere = await this.projectAccess.buildContractWhere(userId, dataScope);
    return { OR: [{ contract: contractWhere }, { contractAllocations: { some: { contract: contractWhere } } }] };
  }
}

