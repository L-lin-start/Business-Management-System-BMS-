import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataScope, Prisma } from '@prisma/client';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { CustomFieldsService } from '../../infrastructure/custom-fields/custom-fields.service';
import { detectStaleVersion, VERSION_CONFLICT_MESSAGE } from '../../infrastructure/concurrency/optimistic-lock';
import { DocumentNumberService } from '../../infrastructure/document-number/document-number.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { HistoryService } from '../history/history.service';
import { parseCalendarDate } from '../../infrastructure/date/calendar-date';
import { OptionsService } from '../options/options.service';
import { ProjectService } from '../projects/project.service';
import { buildDefaultProjectName, resolveItemCount } from './contract-project.factory';
import { CreateContractDto, ContractQueryDto, CreateContractAdjustmentDto, TerminateContractDto, UpdateContractDto } from './dto/contract.dto';
import { ContractStatusService } from './contract-status.service';

@Injectable()
export class ContractService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(DocumentNumberService) private readonly documentNumber: DocumentNumberService,
    @Inject(ProjectService) private readonly projectService: ProjectService,
    @Inject(CustomFieldsService) private readonly customFields: CustomFieldsService,
    @Inject(HistoryService) private readonly historyService: HistoryService,
    @Inject(OptionsService) private readonly optionsService: OptionsService,
    @Inject(ContractStatusService) private readonly contractStatusService: ContractStatusService,
  ) {}

  /**
   * 合同类型只接受系统 B 配置的选项，避免自由文本导致"专利/发明专利/专利业务"各写各的。
   * 返回规范化后的类型值；未填写时返回 null。
   */
  private async normalizeContractType(value: string | undefined | null): Promise<string | null> {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return null;
    return this.optionsService.assertOptionAllowed('contractType', trimmed, '合同类型');
  }

  async list(query: ContractQueryDto, userId: string, dataScope: DataScope) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const scopeWhere = await this.buildScopeWhere(userId, dataScope);
    const where: Prisma.ContractWhereInput = {
      deletedAt: null,
      // 范围过滤与业务筛选用 AND 组合：二者都可能产生 `OR`，
      // 用对象展开会互相覆盖（曾导致带 contractId/keyword 时数据范围失效），见 payment.service 的说明。
      AND: [
        scopeWhere,
        {
          // contractId 为导出（详情页「导出本合同」）新增；列表也支持它，
          // 否则「传了 contractId 却被忽略」会让人以为筛选生效而实际返回全部可见数据。
          ...(query.contractId ? { id: query.contractId } : {}),
          ...(query.statusCode ? { statusCode: query.statusCode } : {}),
          ...(query.customerId ? { customerId: query.customerId } : {}),
          ...(query.keyword
            ? {
                OR: [
                  { contractNo: { contains: query.keyword, mode: 'insensitive' } },
                  { customer: { name: { contains: query.keyword, mode: 'insensitive' } } },
                ],
              }
            : {}),
        },
      ],
    };
    const [records, total] = await this.prisma.$transaction([
      this.prisma.contract.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          customer: { select: { id: true, name: true } },
          owner: { select: { id: true, displayName: true } },
          _count: { select: { projects: true, paymentAllocations: true, costs: true } },
        },
      }),
      this.prisma.contract.count({ where }),
    ]);
    return { items: records, total, page, pageSize };
  }

  async getById(id: string, userId: string, dataScope: DataScope) {
    const contract = await this.prisma.contract.findFirst({
      where: { id, deletedAt: null, ...(await this.buildScopeWhere(userId, dataScope)) },
      include: {
        customer: { select: { id: true, name: true } },
        owner: { select: { id: true, displayName: true } },
        projects: {
          where: { deletedAt: null },
          orderBy: { sequence: 'asc' },
          select: { id: true, projectNo: true, projectName: true, statusCode: true, sequence: true },
        },
        // 合同成本 = 其下项目成本之和
        costs: {
          where: { deletedAt: null },
          orderBy: { incurredAt: 'desc' },
          select: {
            id: true,
            costType: true,
            amount: true,
            incurredAt: true,
            note: true,
            project: { select: { id: true, projectNo: true, projectName: true } },
          },
        },
        // 金额调整（退款/折扣/部分豁免）：不改原金额，单独记账
        adjustments: {
          where: { deletedAt: null },
          orderBy: { occurredAt: 'desc' },
          include: { operator: { select: { id: true, displayName: true } } },
        },
        terminatedBy: { select: { id: true, displayName: true } },
        _count: { select: { projects: true, paymentAllocations: true, costs: true } },
      },
    });
    if (!contract) throw new NotFoundException('合同不存在或无权查看');

    // 不能通过 Contract.receipts 关系读取跨合同回款，因为该关系天然只按 PaymentReceipt.contractId 连接；
    // 这里按合同分配表单独查询，兼容单合同旧数据和跨合同新数据。
    const receipts = await this.prisma.paymentReceipt.findMany({
      where: {
        deletedAt: null,
        OR: [{ contractId: id }, { contractAllocations: { some: { contractId: id } } }],
      },
      orderBy: { receivedAt: 'desc' },
      select: {
        id: true,
        contractId: true,
        receiptNo: true,
        amount: true,
        receivedAt: true,
        paymentMethod: true,
        note: true,
        allocations: {
          include: { project: { select: { id: true, projectNo: true, projectName: true } } },
          orderBy: { project: { sequence: 'asc' } },
        },
        contractAllocations: {
          where: { contractId: id },
          select: { contractId: true, amount: true },
        },
      },
    });

    // 已收款口径与 createAdjustment / assertContractComplete 保持一致（含旧数据兼容），
    // 避免"详情显示 7000、调整校验认为收到 0"这种自相矛盾。
    const collected = await this.sumCollectedForContract(this.prisma, id);
    const costTotal = contract.costs.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
    const adjusted = contract.adjustments.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));

    return {
      ...contract,
      receipts,
      // 汇总口径：合同金额、已收款（收款单合计）、调整额、应收净额、未收款、净收益
      // 未收款 = 合同金额 - 已收款 - 累计调整额（调整额包括退款/折扣/部分豁免）
      totals: {
        contractAmount: contract.amount.toFixed(2),
        collectedAmount: collected.toFixed(2),
        adjustedAmount: adjusted.toFixed(2),
        netReceivable: contract.amount.minus(adjusted).toFixed(2),
        unpaidAmount: contract.amount.minus(collected).minus(adjusted).toFixed(2),
        costAmount: costTotal.toFixed(2),
        netProfit: collected.minus(costTotal).toFixed(2),
      },
      // 终止信息按 PRD 4.2 的 5 个要素回显（未终止时为空）
      termination: contract.terminatedAt
        ? {
            terminatedAt: contract.terminatedAt,
            terminationType: contract.terminationType,
            terminationReason: contract.terminationReason,
            unfinishedProjectAction: contract.unfinishedProjectAction,
            unpaidAmountAction: contract.unpaidAmountAction,
            operatedBy: contract.terminatedBy?.displayName ?? null,
          }
        : null,
    };
  }

  async create(input: CreateContractDto, actorId: string, dataScope: DataScope = 'ALL') {
    const itemCount = resolveItemCount(input.itemCount);
    const contractNo = normalizeContractNo(input.contractNo);
    // 自定义字段按系统 B 的字段定义校验；合同类型只接受配置好的选项
    const contractCustomFields = await this.customFields.sanitize('contract', input.customFields);
    const contractType = await this.normalizeContractType(input.contractType);
    const paymentTerm = await this.normalizeOption('paymentTerm', input.paymentTerm, '付款方式');
    const snapshot = await this.resolveContactSnapshot(input.customerId, input);
    const ownerId = await this.resolveOwnerId(input.ownerId, actorId, dataScope);
    const duplicate = await this.prisma.contract.findUnique({ where: { contractNo }, select: { id: true } });
    if (duplicate) throw new ConflictException('合同编号已存在，请核对后重新填写');
    // 单价 × 件数 与合同金额不一致时给出提示（不阻止保存，业务上可能有尾差）
    const amountMismatch = detectAmountMismatch(input.unitPrice, itemCount, input.amount);

    const { contract, projects } = await (async () => {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const created = await tx.contract.create({
            data: {
              contractNo,
              customerId: input.customerId,
              contractType,
              product: input.product ?? null,
              amount: input.amount,
              itemCount,
              unitPrice: input.unitPrice ?? null,
              paymentTerm,
              remark: input.remark ?? null,
              companyName: snapshot.companyName,
              contactName: snapshot.contactName,
              contactPhone: snapshot.contactPhone,
              contactEmail: snapshot.contactEmail,
              companyAddress: snapshot.companyAddress,
              signedAt: parseCalendarDate(input.signedAt),
              expiryDate: parseCalendarDate(input.expiryDate),
              // 业务起算日：人工填了就存人工值；没填则留空，
              // 由系统在算建议截止日时回退到「合同录入时刻」（见 TimeLimitService.suggest）。
              // 留空而不是立刻写 now()，是为了保证回退口径与 createdAt 完全一致（同一事务内取值可能差几毫秒）。
              businessStartAt: parseCalendarDate(input.businessStartAt),
              legallyDueAt: parseCalendarDate(input.legallyDueAt),
              internalSafetyDate: parseCalendarDate(input.internalSafetyDate),
              statusCode: input.statusCode ?? 'ACTIVE',
              ownerId,
              ...(contractCustomFields ? { customFields: contractCustomFields } : {}),
            },
            include: { customer: { select: { id: true, name: true } }, owner: { select: { id: true, displayName: true } } },
          });

          if (input.autoGenerateProjects === false) return { contract: created, projects: [] };

          // 按件数生成项目：编号由人工合同号派生（合同号-1、合同号-2……）。
          // 项目类型取合同类型对应的中文标签（「专利」等），项目名称默认「合同类型 + 项目-序号」，
          // 这样项目能按类型匹配到同名流程模板。
          const projectTypeLabel = await this.optionsService.resolveOptionLabel('contractType', contractType);
          const generated = [];
          for (let index = 0; index < itemCount; index += 1) {
            const sequence = await this.projectService.nextSequenceWithinTransaction(tx, created.id);
            generated.push(
              await this.projectService.createWithinTransaction(
                tx,
                created.contractNo,
                {
                  contractId: created.id,
                  projectName: buildDefaultProjectName(projectTypeLabel, sequence),
                  projectType: projectTypeLabel,
                  statusCode: 'PENDING',
                  ownerId: created.ownerId,
                },
                sequence,
              ),
            );
          }
          return { contract: created, projects: generated };
        });
      } catch (error) {
        if (this.documentNumber.isUniqueViolation(error)) {
          throw new ConflictException('合同编号已存在，请核对后重新填写');
        }
        throw error;
      }
    })();

    await this.auditService.record({ actorId, action: 'CREATE', resourceType: 'Contract', resourceId: contract.id, afterData: contract });
    // 批量生成的项目单独留痕，便于按项目维度追溯到生成来源。
    for (const project of projects) {
      await this.auditService.record({
        actorId,
        action: 'CREATE',
        resourceType: 'Project',
        resourceId: project.id,
        reason: `合同 ${contract.contractNo} 按件数 ${itemCount} 自动生成`,
        afterData: project,
      });
    }

    return {
      ...contract,
      itemCount,
      generatedProjectCount: projects.length,
      // 单价 × 件数 与合同金额不符时前端提示，但不阻止保存
      amountWarning: amountMismatch,
    };
  }

  /**
   * 合同上的联系人信息快照：显式填写优先，未填写时取客户当前值。
   * 合同留存快照的意义是：客户信息日后变更不应改写历史合同上签约当时的联系人。
   */
  private async resolveContactSnapshot(
    customerId: string,
    input: {
      companyName?: string;
      contactName?: string;
      contactPhone?: string;
      contactEmail?: string;
      companyAddress?: string;
    },
  ) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { name: true, contactName: true, phone: true, email: true, address: true },
    });
    return {
      companyName: input.companyName?.trim() || customer?.name || null,
      contactName: input.contactName?.trim() || customer?.contactName || null,
      contactPhone: input.contactPhone?.trim() || customer?.phone || null,
      contactEmail: input.contactEmail?.trim() || customer?.email || null,
      companyAddress: input.companyAddress?.trim() || customer?.address || null,
    };
  }

  /** 校验并归一化通用下拉选项；未填写返回 null */
  private async normalizeOption(moduleKey: string, value: string | undefined | null, fieldLabel: string) {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return null;
    return this.optionsService.assertOptionAllowed(moduleKey, trimmed, fieldLabel);
  }

  async update(id: string, input: UpdateContractDto, actorId: string, dataScope: DataScope) {
    const before = await this.getEditable(id, actorId, dataScope);
    const nextItemCount = input.itemCount !== undefined ? resolveItemCount(input.itemCount) : before.itemCount;
    const contractCustomFields = input.customFields === undefined
      ? undefined
      : await this.customFields.sanitize('contract', input.customFields);

    // 乐观锁：客户端带来的版本号必须是它读到的版本，否则说明他人已修改
    const stale = detectStaleVersion(before, input.version);
    if (stale.stale) throw new ConflictException(VERSION_CONFLICT_MESSAGE);

    const contractType = input.contractType === undefined ? undefined : await this.normalizeContractType(input.contractType);
    const paymentTerm = input.paymentTerm === undefined
      ? undefined
      : await this.normalizeOption('paymentTerm', input.paymentTerm, '付款方式');
    // 编辑时若带上了联系人相关字段，按「显式值优先、否则取客户当前值」重新生成快照
    const touchesContact = [input.companyName, input.contactName, input.contactPhone, input.contactEmail, input.companyAddress]
      .some((value) => value !== undefined);
    const contactSnapshot:
      | { companyName: string | null; contactName: string | null; contactPhone: string | null; contactEmail: string | null; companyAddress: string | null }
      | undefined = touchesContact ? await this.resolveContactSnapshot(before.customerId, input) : undefined;

    const ownerId = input.ownerId !== undefined
      ? await this.resolveOwnerId(input.ownerId, actorId, dataScope)
      : undefined;

    if (input.statusCode === 'COMPLETED') await this.assertContractComplete(id);

    // 合同编号允许修改：改了之后其下所有项目的编号要跟着改（用户确认：自动跟着改，不问）。
    // 先做重号预检，给出友好提示；事务内仍靠唯一约束兜底并发。
    const nextContractNo = input.contractNo === undefined ? undefined : normalizeContractNo(input.contractNo);
    const contractNoChanged = nextContractNo !== undefined && nextContractNo !== before.contractNo;
    if (contractNoChanged) {
      const duplicate = await this.prisma.contract.findUnique({ where: { contractNo: nextContractNo }, select: { id: true } });
      if (duplicate && duplicate.id !== id) {
        throw new ConflictException(`合同编号「${nextContractNo}」已存在，请核对后重新填写`);
      }
    }

    const contractData = {
      ...(nextContractNo !== undefined ? { contractNo: nextContractNo } : {}),
      ...(contractType !== undefined ? { contractType } : {}),
      ...(input.product !== undefined ? { product: input.product || null } : {}),
      ...(input.amount !== undefined ? { amount: input.amount } : {}),
      ...(input.unitPrice !== undefined ? { unitPrice: input.unitPrice ?? null } : {}),
      ...(input.paymentTerm !== undefined ? { paymentTerm: paymentTerm ?? null } : {}),
      ...(input.remark !== undefined ? { remark: input.remark || null } : {}),
      ...(input.itemCount !== undefined ? { itemCount: nextItemCount } : {}),
      ...(input.signedAt !== undefined ? { signedAt: parseCalendarDate(input.signedAt) } : {}),
      ...(input.expiryDate !== undefined ? { expiryDate: parseCalendarDate(input.expiryDate) } : {}),
      ...(input.businessStartAt !== undefined ? { businessStartAt: parseCalendarDate(input.businessStartAt) } : {}),
      ...(input.legallyDueAt !== undefined ? { legallyDueAt: parseCalendarDate(input.legallyDueAt) } : {}),
      ...(input.internalSafetyDate !== undefined
        ? { internalSafetyDate: parseCalendarDate(input.internalSafetyDate) }
        : {}),
      ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
      ...(ownerId !== undefined ? { ownerId } : {}),
      ...(contactSnapshot ?? {}),
      ...(contractCustomFields !== undefined ? { customFields: contractCustomFields } : {}),
    };

    const { contract, createdProjects, renumberedProjects } = await this.prisma.$transaction(async (tx) => {
      const existingCount = await tx.project.count({ where: { contractId: id, deletedAt: null } });

      // 件数只能调增：调增时按差额补建项目，调减会与已有项目冲突，直接拒绝并说明原因。
      if (input.itemCount !== undefined && nextItemCount < existingCount) {
        throw new ConflictException(
          `该合同已有 ${existingCount} 个项目，件数不能小于 ${existingCount}。如需减少，请先在项目页删除对应项目。`,
        );
      }

      // ownerId 清空（null）只有 unchecked 版本接受，故显式标注类型
      const updateData: Prisma.ContractUncheckedUpdateManyInput = { ...contractData };
      const guarded = await tx.contract.updateMany({
        where: { id, version: input.version },
        data: { ...updateData, version: { increment: 1 } },
      });
      if (guarded.count === 0) throw new ConflictException(VERSION_CONFLICT_MESSAGE);

      const updated = await tx.contract.findUniqueOrThrow({
        where: { id },
        include: { customer: { select: { id: true, name: true } }, owner: { select: { id: true, displayName: true } } },
      });

      // 合同编号改了 → 项目编号前缀跟着改，保持「合同编号-序号」一致。
      // 项目编号 = 合同号 + 序号，序号唯一，因此新编号不会撞车；
      // 但仍按「先清空再写入」处理，避免与既有的同名前缀编号冲突。
      let renumberedProjects = 0;
      if (contractNoChanged) {
        const siblings = await tx.project.findMany({
          where: { contractId: id },
          select: { id: true, sequence: true, projectNo: true },
          orderBy: { sequence: 'asc' },
        });
        for (const sibling of siblings) {
          const nextProjectNo = `${updated.contractNo}-${sibling.sequence}`;
          if (nextProjectNo === sibling.projectNo) continue;
          await tx.project.update({ where: { id: sibling.id }, data: { projectNo: nextProjectNo } });
          renumberedProjects += 1;
        }
      }

      const created = [];
      // 项目类型跟随合同类型（仅用于展示、筛选与新建项目时的流程匹配）；
      // 已生成项目绑定的流程版本不因合同类型变化而改变，避免老项目流程被中途换掉（PRD 4.4）。
      const projectTypeLabel = await this.optionsService.resolveOptionLabel('contractType', updated.contractType);
      if (input.contractType !== undefined) {
        await tx.project.updateMany({
          where: { contractId: id },
          data: { projectType: projectTypeLabel },
        });
      }

      for (let missing = existingCount; missing < nextItemCount; missing += 1) {
        const sequence = await this.projectService.nextSequenceWithinTransaction(tx, id);
        created.push(
          await this.projectService.createWithinTransaction(
            tx,
            updated.contractNo,
            {
              contractId: id,
              projectName: buildDefaultProjectName(projectTypeLabel, sequence),
              projectType: projectTypeLabel,
              statusCode: 'PENDING',
              ownerId: updated.ownerId,
            },
            sequence,
          ),
        );
      }

      return { contract: updated, createdProjects: created, renumberedProjects };
    });

    await this.auditService.record({ actorId, action: 'UPDATE', resourceType: 'Contract', resourceId: id, beforeData: before, afterData: contract });
    // 合同编号变更单独留痕：编号是外部对账凭据，改了必须能追溯
    if (contractNoChanged) {
      await this.auditService.record({
        actorId,
        action: 'RENUMBER',
        resourceType: 'Contract',
        resourceId: id,
        reason: `合同编号由 ${before.contractNo} 改为 ${contract.contractNo}，其下 ${renumberedProjects} 个项目编号同步更新`,
        beforeData: { contractNo: before.contractNo },
        afterData: { contractNo: contract.contractNo, renumberedProjects },
      });
    }
    // 状态变化单独记入历史，供详情页时间线使用
    await this.historyService.recordStatusChange({
      resourceType: 'Contract',
      resourceId: id,
      fromStatusCode: before.statusCode,
      toStatusCode: contract.statusCode,
      reason: input.statusReason ?? null,
      operatorId: actorId,
    });
    await this.contractStatusService.reconcile(id, actorId, '合同资料变更后自动同步合同状态');

    // 补建的项目单独留痕，说明来自件数调整。
    for (const project of createdProjects) {
      await this.auditService.record({
        actorId,
        action: 'CREATE',
        resourceType: 'Project',
        resourceId: project.id,
        reason: `合同 ${contract.contractNo} 件数由 ${before.itemCount} 调整为 ${nextItemCount}，自动补建`,
        afterData: project,
      });
    }

    return { ...contract, generatedProjectCount: createdProjects.length, renumberedProjects };
  }

  /**
   * 软删除合同（PRD 7.2）。
   *
   * ## 规则
   *
   * 1. **必须填删除原因**，落库到 `deleteReason`（核心模块统一口径，恢复视图要用）
   * 2. **有财务数据的合同不允许直接删除**，只能走「终止」（PRD 7.2 最后一条）。
   *    判断口径：该合同下已有有效回款，或其项目下已有有效成本。
   * 3. **级联作废**其下：项目 → 官文 / 邮件送达 / 动作记录 / 申报结果。
   *    这些子记录不再出现在各自列表里，也不再参与统计。
   * 4. **回款不做级联**：回款是合同层面的钱，且已分摊到项目，
   *    作废会破坏分摊一致性、财务对不上账（PRD 原文「财务数据保留」）。
   *    改为在列表/导出/总览处统一按 `contract.deletedAt: null` 过滤 ——
   *    即"记录留着、但不再计入已收款"，与看板口径一致。
   * 5. **成本随项目一起作废**（成本挂项目），因此看板按 `project.deletedAt` 过滤后自动不算。
   *
   * 整个级联在一个事务里完成，避免删了一半留下不一致状态。
   */
  async softDelete(id: string, actorId: string, dataScope: DataScope, reason?: string) {
    const trimmed = reason?.trim();
    if (!trimmed) throw new BadRequestException('请填写删除原因');

    const before = await this.getEditable(id, actorId, dataScope);

    // 财务校验：有回款或有成本 → 拒绝直接删除
    const [allocationCount, legacyReceiptCount, projectIds] = await Promise.all([
      this.prisma.paymentContractAllocation.count({ where: { contractId: id, payment: { deletedAt: null } } }),
      this.prisma.paymentReceipt.count({ where: { contractId: id, deletedAt: null, contractAllocations: { none: {} } } }),
      this.prisma.project.findMany({ where: { contractId: id, deletedAt: null }, select: { id: true } }),
    ]);
    const costCount = await this.prisma.costRecord.count({
      where: { deletedAt: null, project: { contractId: id, deletedAt: null } },
    });
    const paymentCount = allocationCount + legacyReceiptCount;
    if (paymentCount > 0 || costCount > 0) {
      const detail = [
        paymentCount > 0 ? `${paymentCount} 笔回款` : null,
        costCount > 0 ? `${costCount} 笔成本` : null,
      ]
        .filter(Boolean)
        .join('、');
      throw new ConflictException(
        `该合同已产生财务数据（${detail}），不能直接删除。请改用「终止合同」，已发生的回款与成本会保留以便对账。`,
      );
    }

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const contract = await tx.contract.update({
        where: { id },
        data: { deletedAt: now, deleteReason: trimmed, deletedBy: actorId },
      });

      // 级联：项目
      const activeProjectIds = projectIds.map((item) => item.id);
      if (activeProjectIds.length > 0) {
        await tx.project.updateMany({
          where: { id: { in: activeProjectIds }, deletedAt: null },
          data: { deletedAt: now, deleteReason: `所属合同「${before.contractNo}」已删除`, deletedBy: actorId },
        });

        // 级联：项目下的附属记录
        const docIds = (
          await tx.officialDocument.findMany({ where: { projectId: { in: activeProjectIds }, deletedAt: null }, select: { id: true } })
        ).map((item) => item.id);

        await tx.actionRecord.updateMany({
          where: { projectId: { in: activeProjectIds }, deletedAt: null },
          data: { deletedAt: now, deleteReason: `所属合同「${before.contractNo}」已删除`, deletedBy: actorId },
        });
        await tx.filingResult.updateMany({
          where: { projectId: { in: activeProjectIds }, deletedAt: null },
          data: { deletedAt: now, deleteReason: `所属合同「${before.contractNo}」已删除`, deletedBy: actorId },
        });
        await tx.officialDocument.updateMany({
          where: { projectId: { in: activeProjectIds }, deletedAt: null },
          data: { deletedAt: now, deleteReason: `所属合同「${before.contractNo}」已删除`, deletedBy: actorId },
        });
        // 邮件送达挂在官文下，要按官文 id 级联
        if (docIds.length > 0) {
          await tx.mailDelivery.updateMany({
            where: { officialDocumentId: { in: docIds }, deletedAt: null },
            data: { deletedAt: now, deleteReason: `所属合同「${before.contractNo}」已删除`, deletedBy: actorId },
          });
        }
      }

      return contract;
    });

    await this.auditService.record({
      actorId,
      action: 'SOFT_DELETE',
      resourceType: 'Contract',
      resourceId: id,
      reason: trimmed,
      beforeData: before,
      afterData: {
        deletedAt: result.deletedAt,
        deleteReason: result.deleteReason,
        cascadedProjectIds: projectIds.map((item) => item.id),
      },
    });
    return { id, deletedAt: result.deletedAt, cascadedProjects: projectIds.length };
  }

  /**
   * 恢复被软删除的合同（PRD 7.1「可恢复删除数据（仅管理员）」）。
   *
   * 只恢复合同本身与其下项目/附属记录中**因本次级联而作废**的那些。
   * 判断依据是 `deleteReason` 里带的那句级联说明 —— 也就是说
   * 恢复父级不会把"用户自己单独删掉的子记录"一起复活（那属于另一个操作）。
   */
  async restore(id: string, actorId: string, reason?: string) {
    const contract = await this.prisma.contract.findFirst({ where: { id, deletedAt: { not: null } } });
    if (!contract) throw new NotFoundException('该合同不在已删除状态，无需恢复');

    const now = new Date();
    const cascadeReason = `所属合同「${contract.contractNo}」已删除`;

    await this.prisma.$transaction(async (tx) => {
      await tx.contract.update({ where: { id }, data: { deletedAt: null, deleteReason: null, deletedBy: null } });

      const projects = await tx.project.findMany({
        where: { contractId: id, deletedAt: { not: null }, deleteReason: cascadeReason },
        select: { id: true },
      });
      const projectIds = projects.map((item) => item.id);
      if (projectIds.length === 0) return;

      await tx.project.updateMany({
        where: { id: { in: projectIds } },
        data: { deletedAt: null, deleteReason: null, deletedBy: null },
      });
      await tx.officialDocument.updateMany({
        where: { projectId: { in: projectIds }, deleteReason: cascadeReason },
        data: { deletedAt: null, deleteReason: null, deletedBy: null },
      });
      await tx.actionRecord.updateMany({
        where: { projectId: { in: projectIds }, deleteReason: cascadeReason },
        data: { deletedAt: null, deleteReason: null, deletedBy: null },
      });
      await tx.filingResult.updateMany({
        where: { projectId: { in: projectIds }, deleteReason: cascadeReason },
        data: { deletedAt: null, deleteReason: null, deletedBy: null },
      });
      const docIds = (
        await tx.officialDocument.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } })
      ).map((item) => item.id);
      if (docIds.length > 0) {
        await tx.mailDelivery.updateMany({
          where: { officialDocumentId: { in: docIds }, deleteReason: cascadeReason },
          data: { deletedAt: null, deleteReason: null, deletedBy: null },
        });
      }
    });

    await this.auditService.record({
      actorId,
      action: 'RESTORE',
      resourceType: 'Contract',
      resourceId: id,
      reason: reason?.trim() || '管理员恢复已删除的合同',
      beforeData: { deletedAt: contract.deletedAt, deleteReason: contract.deleteReason },
      afterData: { deletedAt: null },
    });
    // 恢复时间戳只用于提示，不是业务字段
    void now;
    return { id, restored: true };
  }

  /* ---------------- 合同终止（PRD 4.2） ---------------- */

  /**
   * 终止合同：一次记录 PRD 要求的 5 个要素。
   *
   * | PRD 要素 | 落库字段 |
   * |---|---|
   * | 终止日期 | terminatedAt |
   * | 终止类型 | terminationType |
   * | 终止原因 | terminationReason |
   * | 未完成项目处理 | unfinishedProjectAction（为「项目一并终止」时批量置为已终止） |
   * | 未回款处理 | unpaidAmountAction |
   */
  async terminate(id: string, input: TerminateContractDto, actorId: string, dataScope: DataScope) {
    const before = await this.getEditable(id, actorId, dataScope);

    // 终止不可逆，用严格版本比对（不走 detectStaleVersion 的 2 秒容差）：
    // 容差是给"同一人快速重试"的普通编辑用的，用在终止上会让并发终止都被放行。
    // 同时先校验版本再校验业务状态，避免"版本已过期"被"已终止"掩盖。
    if (before.version !== input.version) throw new ConflictException(VERSION_CONFLICT_MESSAGE);
    if (before.statusCode === 'TERMINATED') throw new ConflictException('该合同已终止，无需重复操作');

    // 五个要素里的四个选项必须来自系统 B 配置，避免自由文本
    const terminationType = await this.optionsService.assertOptionAllowed('terminationType', input.terminationType, '终止类型');
    const unfinishedProjectAction = await this.optionsService.assertOptionAllowed(
      'unfinishedProjectAction',
      input.unfinishedProjectAction,
      '未完成项目处理方式',
    );
    const unpaidAmountAction = await this.optionsService.assertOptionAllowed('unpaidAmountAction', input.unpaidAmountAction, '未回款处理方式');

    const terminatedAt = parseCalendarDate(input.terminatedAt) ?? new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const guarded = await tx.contract.updateMany({
        where: { id, version: input.version },
        data: {
          statusCode: 'TERMINATED',
          terminatedAt,
          terminationType,
          terminationReason: input.terminationReason,
          unfinishedProjectAction,
          unpaidAmountAction,
          terminatedById: actorId,
          version: { increment: 1 },
        },
      });
      if (guarded.count === 0) throw new ConflictException(VERSION_CONFLICT_MESSAGE);

      // 「项目一并终止」：把未完成的项目置为已终止；已完成的保持完成，不抹掉历史
      let terminatedProjects = 0;
      if (unfinishedProjectAction === 'TERMINATE') {
        const unfinished = await tx.project.findMany({
          where: { contractId: id, deletedAt: null, statusCode: { notIn: ['COMPLETED', 'TERMINATED'] } },
          select: { id: true, statusCode: true },
        });
        if (unfinished.length > 0) {
          await tx.project.updateMany({
            where: { id: { in: unfinished.map((item) => item.id) } },
            data: { statusCode: 'TERMINATED' },
          });
          await tx.statusChangeHistory.createMany({
            data: unfinished.map((item) => ({
              resourceType: 'Project',
              resourceId: item.id,
              fromStatusCode: item.statusCode,
              toStatusCode: 'TERMINATED',
              reason: `所属合同 ${before.contractNo} 终止（${input.terminationReason}）`,
              operatorId: actorId,
            })),
          });
          terminatedProjects = unfinished.length;
        }
      }

      await tx.statusChangeHistory.create({
        data: {
          resourceType: 'Contract',
          resourceId: id,
          fromStatusCode: before.statusCode,
          toStatusCode: 'TERMINATED',
          reason: input.terminationReason,
          operatorId: actorId,
        },
      });

      const updated = await tx.contract.findUniqueOrThrow({ where: { id } });
      return { contract: updated, terminatedProjects };
    });

    await this.auditService.record({
      actorId,
      action: 'TERMINATE',
      resourceType: 'Contract',
      resourceId: id,
      reason: `合同终止：${input.terminationReason}`,
      beforeData: { statusCode: before.statusCode },
      afterData: {
        statusCode: 'TERMINATED',
        terminatedAt,
        terminationType,
        unfinishedProjectAction,
        unpaidAmountAction,
        terminatedProjects: result.terminatedProjects,
      },
    });

    return { ...result.contract, terminatedProjects: result.terminatedProjects };
  }

  /**
   * 计算某合同的「已收款」。
   *
   * 单合同回款（旧数据）只写 `PaymentReceipt.contractId`，没有分配记录；
   * 跨合同回款（新数据）才写 `PaymentContractAllocation`。
   * 因此口径必须两者兼容，否则**旧数据会被算成 0** —— 会导致：
   *   1. 金额调整的"应收不得小于已收款"校验失效
   *   2. 合同完成条件误判为"钱没到账"
   *   3. 详情页已收款显示为 0
   *
   * 规则：合同下若有分配记录，按其金额合计（跨合同只算属于本合同的那部分）；
   *       否则退回该合同名下收款单的整单金额（旧数据口径）。
   */
  private async sumCollectedForContract(tx: Prisma.TransactionClient | PrismaService, contractId: string): Promise<Prisma.Decimal> {
    const [allocationRows, legacyRows] = await Promise.all([
      tx.paymentContractAllocation.findMany({
        where: { contractId, payment: { deletedAt: null } },
        select: { amount: true },
      }),
      tx.paymentReceipt.findMany({
        where: { contractId, deletedAt: null, contractAllocations: { none: {} } },
        select: { amount: true },
      }),
    ]);
    return [...allocationRows, ...legacyRows].reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
  }

  /* ---------------- 合同金额调整（退款 / 折扣 / 部分豁免） ---------------- */

  /**
   * 新增金额调整。
   *
   * 取舍：不改 `Contract.amount`，而是单独记一笔。原金额可追溯、调整历史完整，
   * 未收款 = 合同金额 - 已收款 - 累计调整额。
   *
   * 校验：调整后应收金额不能小于已收款（否则等于把已经收进来的钱也"调掉"了，
   * 那种情况应该走退款流程并登记一笔回款冲销，不能用金额调整掩盖）。
   */
  async createAdjustment(contractId: string, input: CreateContractAdjustmentDto, actorId: string, dataScope: DataScope) {
    const contract = await this.getEditable(contractId, actorId, dataScope);
    const adjustType = await this.optionsService.assertOptionAllowed('adjustType', input.adjustType, '调整类型');

    const [collected, adjustmentRows] = await Promise.all([
      this.sumCollectedForContract(this.prisma, contractId),
      this.prisma.contractAmountAdjustment.findMany({ where: { contractId, deletedAt: null }, select: { amount: true } }),
    ]);
    const existing = adjustmentRows.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
    const added = new Prisma.Decimal(input.amount);
    const netReceivable = contract.amount.minus(existing).minus(added);

    if (netReceivable.lessThan(collected)) {
      throw new ConflictException(
        `调整后应收净额 ¥${netReceivable.toFixed(2)} 小于已收款 ¥${collected.toFixed(2)}。` +
          `如确需退还已收款项，请登记退款回款并做冲销，不要用金额调整覆盖已收金额。`,
      );
    }

    const adjustment = await this.prisma.contractAmountAdjustment.create({
      data: {
        contractId,
        adjustType,
        amount: added,
        reason: input.reason ?? null,
        occurredAt: parseCalendarDate(input.occurredAt) ?? new Date(),
        note: input.note ?? null,
        operatorId: actorId,
      },
    });

    await this.auditService.record({
      actorId,
      action: 'ADJUST_AMOUNT',
      resourceType: 'Contract',
      resourceId: contractId,
      reason: input.reason ?? `合同金额调整：${adjustType} ¥${added.toFixed(2)}`,
      beforeData: { adjustedAmount: existing.toFixed(2), netReceivable: contract.amount.minus(existing).toFixed(2) },
      afterData: { adjustedAmount: existing.plus(added).toFixed(2), netReceivable: netReceivable.toFixed(2) },
    });
    await this.contractStatusService.reconcile(contractId, actorId, '合同金额调整后自动同步合同状态');

    return adjustment;
  }

  /** 该合同的金额调整明细与累计额 */
  async listAdjustments(contractId: string, actorId: string, dataScope: DataScope) {
    await this.getEditable(contractId, actorId, dataScope);
    const items = await this.prisma.contractAmountAdjustment.findMany({
      where: { contractId, deletedAt: null },
      orderBy: { occurredAt: 'desc' },
      include: { operator: { select: { id: true, displayName: true } } },
    });
    const total = items.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
    return { items, total: total.toFixed(2) };
  }

  /** 撤销一笔金额调整（软删除，保留痕迹） */
  async removeAdjustment(contractId: string, adjustmentId: string, actorId: string, dataScope: DataScope) {
    await this.getEditable(contractId, actorId, dataScope);
    const before = await this.prisma.contractAmountAdjustment.findFirst({ where: { id: adjustmentId, contractId, deletedAt: null } });
    if (!before) throw new NotFoundException('金额调整记录不存在');

    const removed = await this.prisma.contractAmountAdjustment.update({
      where: { id: adjustmentId },
      data: { deletedAt: new Date() },
    });
    await this.auditService.record({
      actorId,
      action: 'SOFT_DELETE',
      resourceType: 'ContractAmountAdjustment',
      resourceId: adjustmentId,
      reason: `撤销合同金额调整：${before.adjustType} ¥${before.amount.toFixed(2)}`,
      beforeData: before,
      afterData: removed,
    });
    await this.contractStatusService.reconcile(contractId, actorId, '撤销合同金额调整后自动同步合同状态');
    return { id: adjustmentId, deletedAt: removed.deletedAt };
  }

  /** 合同只能在全部项目完成且净应收款已收齐时进入完成状态。 */
  private async assertContractComplete(id: string) {
    const [contract, projects, collected, adjustments] = await Promise.all([
      this.prisma.contract.findUnique({ where: { id }, select: { amount: true } }),
      this.prisma.project.findMany({ where: { contractId: id, deletedAt: null }, select: { statusCode: true } }),
      this.sumCollectedForContract(this.prisma, id),
      this.prisma.contractAmountAdjustment.findMany({ where: { contractId: id, deletedAt: null }, select: { amount: true } }),
    ]);
    if (!contract) throw new NotFoundException('合同不存在');
    if (projects.length === 0 || projects.some((project) => project.statusCode !== 'COMPLETED')) {
      throw new ConflictException('合同只有在全部项目完成后才能标记为已完成');
    }
    const adjusted = adjustments.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
    if (collected.plus(adjusted).lessThan(contract.amount)) {
      throw new ConflictException('合同只有在净应收款全部收齐（含退款、折扣、坏账或豁免调整）后才能标记为已完成');
    }
  }

  private async getEditable(id: string, userId: string, dataScope: DataScope) {
    const contract = await this.prisma.contract.findFirst({ where: { id, deletedAt: null, ...(await this.buildScopeWhere(userId, dataScope)) } });
    if (!contract) throw new NotFoundException('合同不存在或无权操作');
    return contract;
  }

  /**
   * 导出的过滤条件（PRD 4.12）。
   * 复用列表用的 `buildScopeWhere`，与列表口径完全一致，避免导出越权。
   */
  async buildExportWhere(query: ContractQueryDto, userId: string, dataScope: DataScope): Promise<Prisma.ContractWhereInput> {
    return {
      deletedAt: null,
      // 与 list() 一致的 AND 组合，避免 `OR` 覆盖导致导出越权
      AND: [
        await this.buildScopeWhere(userId, dataScope),
        {
          // 详情页「导出本合同」只传 contractId
          ...(query.contractId ? { id: query.contractId } : {}),
          ...(query.statusCode ? { statusCode: query.statusCode } : {}),
          ...(query.customerId ? { customerId: query.customerId } : {}),
          ...(query.keyword
            ? {
                OR: [
                  { contractNo: { contains: query.keyword, mode: 'insensitive' } },
                  { customer: { name: { contains: query.keyword, mode: 'insensitive' } } },
                ],
              }
            : {}),
        },
      ],
    };
  }

  private async buildScopeWhere(userId: string, dataScope: DataScope): Promise<Prisma.ContractWhereInput> {
    if (dataScope === 'ALL') return {};
    if (dataScope === 'SELF') return { ownerId: userId };
    if (dataScope === 'RELATED') return { OR: [{ ownerId: userId }, { projects: { some: { ownerId: userId } } }, { customer: { ownerId: userId } }] };
    if (dataScope === 'NONE') return { id: '__NO_ACCESS__' };
    const memberships = await this.prisma.userDepartment.findMany({ where: { userId }, select: { departmentId: true } });
    const departmentIds = new Set(memberships.map((item) => item.departmentId));
    if (dataScope === 'DEPARTMENT_AND_DESCENDANTS') {
      const departments = await this.prisma.department.findMany({ select: { id: true, parentId: true } });
      let changed = true;
      while (changed) {
        changed = false;
        for (const department of departments) {
          if (department.parentId && departmentIds.has(department.parentId) && !departmentIds.has(department.id)) {
            departmentIds.add(department.id);
            changed = true;
          }
        }
      }
    }
    const members = await this.prisma.userDepartment.findMany({ where: { departmentId: { in: [...departmentIds] } }, select: { userId: true } });
    const ownerIds = [...new Set(members.map((item) => item.userId))];
    return { OR: [{ ownerId: { in: ownerIds } }, { customer: { ownerId: { in: ownerIds } } }] };
  }

  /** 合同负责人决定合同及其项目的销售数据范围。 */
  private async resolveOwnerId(requestedOwnerId: string | undefined, actorId: string, dataScope: DataScope) {
    const ownerId = requestedOwnerId?.trim() || actorId;
    if (ownerId !== actorId && dataScope !== 'ALL') {
      throw new ForbiddenException('当前角色只能将合同分配给自己');
    }
    const owner = await this.prisma.user.findFirst({
      where: { id: ownerId, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    if (!owner) throw new NotFoundException('所属销售账号不存在或已停用');
    return owner.id;
  }
}

/**
 * 归一化并校验人工填写的合同编号。
 *
 * 规则（用户确认）：非空、不含空白字符（空格/制表/换行）、不超过 50 字。
 * 为什么在服务层再校验一次：DTO 的 @Matches 只在 HTTP 管道生效，
 * 直接调用服务（脚本、内部调用、未来的批量导入）会绕过它 —— 编号里带空格会让项目编号变成
 * 「HT 2026 -1」这种形态，所以这一层必须兜住。
 */
function normalizeContractNo(value: string | undefined | null): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) throw new BadRequestException('合同编号为必填，请按实际合同填写');
  if (/\s/.test(trimmed)) {
    throw new BadRequestException('合同编号不能包含空格、制表符或换行');
  }
  if (trimmed.length > 50) {
    throw new BadRequestException('合同编号最多 50 个字符');
  }
  return trimmed;
}

/**
 * 单价 × 件数 与合同金额不一致时返回提示文案（不阻止保存）。
 * 业务上可能有尾差或打包价，所以只提示不拦截。
 */
function detectAmountMismatch(unitPrice: number | undefined, itemCount: number, amount: number): string | null {
  if (unitPrice === undefined || unitPrice === null) return null;
  const expected = new Prisma.Decimal(unitPrice).times(itemCount);
  const actual = new Prisma.Decimal(amount);
  if (expected.equals(actual)) return null;
  return `单价 ¥${new Prisma.Decimal(unitPrice).toFixed(2)} × 件数 ${itemCount} = ¥${expected.toFixed(2)}，与合同金额 ¥${actual.toFixed(2)} 不一致，请确认。`;
}

