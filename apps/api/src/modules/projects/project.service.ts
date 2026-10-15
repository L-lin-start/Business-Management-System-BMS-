import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataScope, Prisma } from '@prisma/client';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { CustomFieldsService } from '../../infrastructure/custom-fields/custom-fields.service';
import { detectStaleVersion, VERSION_CONFLICT_MESSAGE } from '../../infrastructure/concurrency/optimistic-lock';
import { DocumentNumberService } from '../../infrastructure/document-number/document-number.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { HistoryService } from '../history/history.service';
import { WorkflowService } from '../workflows/workflow.service';
import { parseCalendarDate } from '../../infrastructure/date/calendar-date';
import { OptionsService } from '../options/options.service';
import { CreateProjectDto, ProjectQueryDto, UpdateProjectDto } from './dto/project.dto';
import { ContractStatusService } from '../contracts/contract-status.service';
import { ProjectAccessScopeService } from '../../infrastructure/project-access/project-access-scope.service';

/** 节点配置里的统计状态编码，缺省视为进行中 */
function readNodeStatisticsCode(settings: Prisma.JsonValue | null | undefined): string {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const value = (settings as { statisticsCode?: unknown }).statisticsCode;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return 'IN_PROGRESS';
}

/** 在事务内创建项目所需的字段，去掉由服务端生成的编号与序号。 */
export type ProjectCreationData = {
  contractId: string;
  projectName: string;
  projectType?: string | null | undefined;
  statusCode?: string | undefined;
  ownerId?: string | null | undefined;
  startDate?: Date | null | undefined;
  dueDate?: Date | null | undefined;
  customFields?: Prisma.InputJsonValue | undefined;
};

@Injectable()
export class ProjectService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(DocumentNumberService) private readonly documentNumber: DocumentNumberService,
    @Inject(CustomFieldsService) private readonly customFields: CustomFieldsService,
    @Inject(HistoryService) private readonly historyService: HistoryService,
    @Inject(WorkflowService) private readonly workflowService: WorkflowService,
    @Inject(OptionsService) private readonly optionsService: OptionsService,
    @Inject(ContractStatusService) private readonly contractStatusService: ContractStatusService,
    @Inject(ProjectAccessScopeService) private readonly projectAccess: ProjectAccessScopeService,
  ) {}

  async list(query: ProjectQueryDto, userId: string, dataScope: DataScope) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const scopeWhere = await this.buildScopeWhere(userId, dataScope);
    const where: Prisma.ProjectWhereInput = {
      deletedAt: null,
      // 范围过滤与业务筛选用 AND 组合（两者都可能产生 `OR`，展开会互相覆盖）
      AND: [
        scopeWhere,
        {
          ...(query.statusCode ? { statusCode: query.statusCode } : {}),
          ...(query.contractId ? { contractId: query.contractId } : {}),
          ...(query.keyword
            ? {
                OR: [
                  { projectNo: { contains: query.keyword, mode: 'insensitive' } },
                  { projectName: { contains: query.keyword, mode: 'insensitive' } },
                  { contract: { contractNo: { contains: query.keyword, mode: 'insensitive' } } },
                  { contract: { customer: { name: { contains: query.keyword, mode: 'insensitive' } } } },
                ],
              }
            : {}),
        },
      ],
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.project.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { sequence: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          contract: { select: { id: true, contractNo: true, customer: { select: { id: true, name: true } } } },
          owner: { select: { id: true, displayName: true } },
          // 列表直接显示项目走的流程与当前节点，避免"这条项目按哪套流程走"只能进详情才知道
          workflowVersion: {
            select: {
              id: true,
              version: true,
              template: { select: { name: true } },
              nodes: { select: { code: true, name: true } },
            },
          },
          _count: { select: { costs: true, payments: true } },
        },
      }),
      this.prisma.project.count({ where }),
    ]);

    // 未绑定版本的项目（历史数据）按项目类型解析当前已发布流程，保证列表与详情口径一致
    const fallbackCache = new Map<string, { templateName: string; version: number; nodeNameByCode: Map<string, string> }>();
    const enriched = [];
    for (const item of items) {
      if (item.workflowVersion) {
        const nodeNameByCode = new Map(item.workflowVersion.nodes.map((node) => [node.code, node.name]));
        enriched.push({
          ...item,
          workflow: {
            bound: true,
            templateName: item.workflowVersion.template.name,
            version: item.workflowVersion.version,
            currentNodeName: item.currentNodeCode ? nodeNameByCode.get(item.currentNodeCode) ?? item.currentNodeCode : null,
          },
        });
        continue;
      }

      const cacheKey = item.projectType ?? '';
      if (!fallbackCache.has(cacheKey)) {
        const published = await this.workflowService.findPublishedVersionForProjectType(item.projectType);
        if (!published) {
          fallbackCache.set(cacheKey, { templateName: '', version: 0, nodeNameByCode: new Map() });
        } else {
          const nodes = await this.prisma.workflowNode.findMany({
            where: { versionId: published.id },
            select: { code: true, name: true },
          });
          fallbackCache.set(cacheKey, {
            templateName: published.template.name,
            version: published.version,
            nodeNameByCode: new Map(nodes.map((node) => [node.code, node.name])),
          });
        }
      }
      const fallback = fallbackCache.get(cacheKey)!;
      enriched.push({
        ...item,
        workflow: fallback.templateName
          ? {
              bound: false,
              templateName: fallback.templateName,
              version: fallback.version,
              currentNodeName: item.currentNodeCode ? fallback.nodeNameByCode.get(item.currentNodeCode) ?? item.currentNodeCode : null,
            }
          : { bound: false, templateName: null, version: null, currentNodeName: null },
      });
    }

    return { items: enriched, total, page, pageSize };
  }

  async getById(id: string, userId: string, dataScope: DataScope) {
    const project = await this.prisma.project.findFirst({
      where: { id, deletedAt: null, ...(await this.buildScopeWhere(userId, dataScope)) },
      include: {
        contract: { select: { id: true, contractNo: true, amount: true, customer: { select: { id: true, name: true } } } },
        owner: { select: { id: true, displayName: true } },
        // 项目回款 = 分摊到本项目的金额；一笔回款可在同一合同内多个项目间拆分
        payments: {
          where: { payment: { deletedAt: null } },
          orderBy: { payment: { receivedAt: 'desc' } },
          select: {
            amount: true,
            payment: {
              select: { id: true, receiptNo: true, amount: true, receivedAt: true, paymentMethod: true, note: true },
            },
          },
        },
        costs: {
          where: { deletedAt: null },
          orderBy: { incurredAt: 'desc' },
          select: { id: true, costType: true, amount: true, incurredAt: true, note: true },
        },
        _count: { select: { costs: true, payments: true } },
      },
    });
    if (!project) throw new NotFoundException('项目不存在或无权查看');

    const collected = project.payments.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
    const costTotal = project.costs.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));

    // 流程上下文：当前节点 + 所属版本的完整节点序列，供详情页展示与推进
    const workflow = await this.resolveWorkflowContext(project);

    return {
      ...project,
      workflow,
      totals: {
        collectedAmount: collected.toFixed(2),
        costAmount: costTotal.toFixed(2),
        netProfit: collected.minus(costTotal).toFixed(2),
      },
    };
  }

  /**
   * 项目类型只接受系统 B 配置的选项；统一存中文标签，
   * 这样项目能按类型匹配到同名流程模板（专利/商标/软著/项目）。
   */
  private async normalizeProjectType(value: string | undefined | null): Promise<string | null> {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return null;
    const code = await this.optionsService.assertOptionAllowed('projectType', trimmed, '项目类型');
    return this.optionsService.resolveOptionLabel('projectType', code);
  }

  /** 项目绑定的流程版本、当前节点、下一节点与完整节点序列 */
  private async resolveWorkflowContext(project: { id: string; projectType: string | null; workflowVersionId: string | null; currentNodeCode: string | null }) {
    let versionId = project.workflowVersionId;
    if (!versionId) {
      const published = await this.workflowService.findPublishedVersionForProjectType(project.projectType);
      if (!published) return { bound: false, version: null, currentNode: null, nextNode: null, nodes: [] };
      versionId = published.id;
    }

    const version = await this.prisma.workflowVersion.findUnique({
      where: { id: versionId },
      include: {
        template: { select: { name: true } },
        nodes: { orderBy: { sequence: 'asc' } },
      },
    });
    if (!version) return { bound: false, version: null, currentNode: null, nextNode: null, nodes: [] };

    const nodes = version.nodes.map((node) => ({
      code: node.code,
      name: node.name,
      sequence: node.sequence,
      assigneeType: node.assigneeType,
      assigneeId: node.assigneeId,
      deadlineDays: node.deadlineDays,
      warningDays: node.warningDays,
      statisticsCode: readNodeStatisticsCode(node.settings),
    }));
    const currentIndex = project.currentNodeCode ? nodes.findIndex((node) => node.code === project.currentNodeCode) : -1;

    return {
      bound: true,
      version: { id: version.id, version: version.version, status: version.status, templateName: version.template.name },
      currentNode: currentIndex >= 0 ? nodes[currentIndex] : null,
      nextNode: currentIndex >= 0 ? nodes[currentIndex + 1] ?? null : nodes[0] ?? null,
      nodes,
    };
  }

  async create(input: CreateProjectDto, actorId: string, dataScope: DataScope = 'ALL') {
    await this.projectAccess.assertContractAccess(input.contractId, actorId, dataScope);
    const contract = await this.ensureContract(input.contractId);
    // 自定义字段按系统 B 的字段定义校验；项目类型只接受配置好的选项
    const projectCustomFields = await this.customFields.sanitize('project', input.customFields);
    const projectType = await this.normalizeProjectType(input.projectType);
    let project;
    try {
      project = await this.prisma.$transaction((tx) =>
        this.createWithinTransaction(tx, contract.contractNo, {
          contractId: input.contractId,
          projectName: input.projectName.trim(),
          projectType,
          statusCode: input.statusCode ?? 'PENDING',
          ownerId: input.ownerId ?? actorId,
          startDate: parseCalendarDate(input.startDate),
          dueDate: parseCalendarDate(input.dueDate),
          customFields: projectCustomFields,
        }),
      );
    } catch (error) {
      if (this.documentNumber.isUniqueViolation(error)) {
        throw new ConflictException('该项目序号已被占用，请重试');
      }
      throw error;
    }
    await this.auditService.record({ actorId, action: 'CREATE', resourceType: 'Project', resourceId: project.id, afterData: project });
    return project;
  }

  /**
   * 在给定事务内创建项目：合同内序号自动下排，项目编号由合同号派生。
   * 供手工建项目（create）和合同按件数批量生成/补建（ContractService）共用，
   * 由调用方负责审计留痕，避免批量生成时重复记账。
   * 循环批量建项目时请先用 nextSequenceWithinTransaction 取号并显式传入 sequence，
   * 否则同一次批量里每次都会重新查询，序号判断依据会滞后。
   */
  async createWithinTransaction(tx: Prisma.TransactionClient, contractNo: string, data: ProjectCreationData, sequence?: number) {
    const resolvedSequence = sequence ?? (await this.nextSequenceWithinTransaction(tx, data.contractId));
    const projectNo = this.documentNumber.buildProjectNo(contractNo, resolvedSequence);

    // 绑定流程：按项目类型取当前已发布版本，并落到第一个节点（PRD 4.3/4.4）
    // 新项目走新版本，老项目已绑定的版本不受影响
    const workflow = await this.workflowService.findPublishedVersionForProjectType(data.projectType ?? null);
    let workflowVersionId: string | null = null;
    let currentNodeCode: string | null = null;
    let currentNodeEnteredAt: Date | null = null;
    if (workflow) {
      const firstNode = await tx.workflowNode.findFirst({
        where: { versionId: workflow.id },
        orderBy: { sequence: 'asc' },
        select: { code: true },
      });
      if (firstNode) {
        workflowVersionId = workflow.id;
        currentNodeCode = firstNode.code;
        currentNodeEnteredAt = new Date();
      }
    }

    return tx.project.create({
      data: {
        projectNo,
        contractId: data.contractId,
        sequence: resolvedSequence,
        projectName: data.projectName,
        projectType: data.projectType ?? null,
        statusCode: data.statusCode ?? 'PENDING',
        workflowVersionId,
        currentNodeCode,
        currentNodeEnteredAt,
        ownerId: data.ownerId ?? null,
        startDate: data.startDate ?? null,
        dueDate: data.dueDate ?? null,
        ...(data.customFields ? { customFields: data.customFields as Prisma.InputJsonValue } : {}),
      },
      include: { contract: { select: { id: true, contractNo: true } }, owner: { select: { id: true, displayName: true } } },
    });
  }

  /** 取合同内下一个可用序号（含已软删除项目，保证不与历史编号冲突）。 */
  async nextSequenceWithinTransaction(tx: Prisma.TransactionClient, contractId: string) {
    return this.nextSequence(contractId, tx);
  }

  async update(id: string, input: UpdateProjectDto, actorId: string, dataScope: DataScope) {
    const before = await this.getEditable(id, actorId, dataScope);
    const projectCustomFields = input.customFields === undefined
      ? undefined
      : await this.customFields.sanitize('project', input.customFields);

    // 乐观锁：客户端带来的版本号必须是它读到的版本，否则说明他人已修改
    const stale = detectStaleVersion(before, input.version);
    if (stale.stale) throw new ConflictException(VERSION_CONFLICT_MESSAGE);

    const projectType = input.projectType === undefined ? undefined : await this.normalizeProjectType(input.projectType);

    if (input.statusCode === 'COMPLETED' && before.statusCode !== 'COMPLETED') {
      await this.assertProjectComplete(id);
    }

    const guarded = await this.prisma.project.updateMany({
      where: { id, version: input.version },
      data: {
        ...(input.projectName !== undefined ? { projectName: input.projectName.trim() } : {}),
        ...(projectType !== undefined ? { projectType } : {}),
        ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId || null } : {}),
        ...(input.startDate !== undefined ? { startDate: parseCalendarDate(input.startDate) } : {}),
        ...(input.dueDate !== undefined ? { dueDate: parseCalendarDate(input.dueDate) } : {}),
        ...(projectCustomFields !== undefined ? { customFields: projectCustomFields } : {}),
        version: { increment: 1 },
      },
    });
    if (guarded.count === 0) throw new ConflictException(VERSION_CONFLICT_MESSAGE);

    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id },
      include: { contract: { select: { id: true, contractNo: true } }, owner: { select: { id: true, displayName: true } } },
    });
    await this.auditService.record({ actorId, action: 'UPDATE', resourceType: 'Project', resourceId: id, beforeData: before, afterData: project });
    // 状态变化单独记入历史，供详情页时间线使用
    await this.historyService.recordStatusChange({
      resourceType: 'Project',
      resourceId: id,
      fromStatusCode: before.statusCode,
      toStatusCode: project.statusCode,
      reason: input.statusReason ?? null,
      operatorId: actorId,
    });
    await this.contractStatusService.reconcile(project.contractId, actorId, '项目状态变更后自动同步合同状态');
    return project;
  }

  /**
   * 软删除项目（PRD 7.2）。
   *
   * 1. 必须填删除原因，落库 `deleteReason`
   * 2. **已产生成本的不可直接删除**，改用「终止/作废」（PRD 7.2 最后一条）
   * 3. 级联作废其下：官文 / 邮件送达 / 动作记录 / 申报结果
   * 4. 回款分摊记录**不级联删除**：回款是合同层面的钱，删项目不应让合同少收钱。
   *    但项目作废后，其分摊金额仍会留在合同已收款里 —— 这是刻意的：
   *    钱确实收到了，只是项目不做了。要冲销应登记退款回款，而不是删项目。
   */
  async softDelete(id: string, actorId: string, dataScope: DataScope, reason?: string) {
    const trimmed = reason?.trim();
    if (!trimmed) throw new BadRequestException('请填写删除原因');

    const before = await this.getEditable(id, actorId, dataScope);

    const costCount = await this.prisma.costRecord.count({ where: { projectId: id, deletedAt: null } });
    if (costCount > 0) {
      throw new ConflictException(
        `该项目已登记 ${costCount} 笔成本，不能直接删除。请先移除成本，或改用项目状态「已终止」保留记录以便对账。`,
      );
    }

    const now = new Date();
    const cascadeReason = `所属项目「${before.projectNo}」已删除`;
    const result = await this.prisma.$transaction(async (tx) => {
      const project = await tx.project.update({
        where: { id },
        data: { deletedAt: now, deleteReason: trimmed, deletedBy: actorId },
      });

      const docIds = (
        await tx.officialDocument.findMany({ where: { projectId: id, deletedAt: null }, select: { id: true } })
      ).map((item) => item.id);

      await tx.actionRecord.updateMany({
        where: { projectId: id, deletedAt: null },
        data: { deletedAt: now, deleteReason: cascadeReason, deletedBy: actorId },
      });
      await tx.filingResult.updateMany({
        where: { projectId: id, deletedAt: null },
        data: { deletedAt: now, deleteReason: cascadeReason, deletedBy: actorId },
      });
      await tx.officialDocument.updateMany({
        where: { projectId: id, deletedAt: null },
        data: { deletedAt: now, deleteReason: cascadeReason, deletedBy: actorId },
      });
      if (docIds.length > 0) {
        await tx.mailDelivery.updateMany({
          where: { officialDocumentId: { in: docIds }, deletedAt: null },
          data: { deletedAt: now, deleteReason: cascadeReason, deletedBy: actorId },
        });
      }
      return project;
    });

    await this.auditService.record({
      actorId,
      action: 'SOFT_DELETE',
      resourceType: 'Project',
      resourceId: id,
      reason: trimmed,
      beforeData: before,
      afterData: { deletedAt: result.deletedAt, deleteReason: result.deleteReason },
    });
    return { id, deletedAt: result.deletedAt };
  }

  /** 恢复被软删除的项目（PRD 7.1，仅管理员）。只恢复因级联而作废的子记录。 */
  async restore(id: string, actorId: string, reason?: string) {
    const project = await this.prisma.project.findFirst({ where: { id, deletedAt: { not: null } } });
    if (!project) throw new NotFoundException('该项目不在已删除状态，无需恢复');
    const cascadeReason = `所属项目「${project.projectNo}」已删除`;

    await this.prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id }, data: { deletedAt: null, deleteReason: null, deletedBy: null } });
      await tx.officialDocument.updateMany({
        where: { projectId: id, deleteReason: cascadeReason },
        data: { deletedAt: null, deleteReason: null, deletedBy: null },
      });
      await tx.actionRecord.updateMany({
        where: { projectId: id, deleteReason: cascadeReason },
        data: { deletedAt: null, deleteReason: null, deletedBy: null },
      });
      await tx.filingResult.updateMany({
        where: { projectId: id, deleteReason: cascadeReason },
        data: { deletedAt: null, deleteReason: null, deletedBy: null },
      });
      const docIds = (
        await tx.officialDocument.findMany({ where: { projectId: id }, select: { id: true } })
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
      resourceType: 'Project',
      resourceId: id,
      reason: reason?.trim() || '管理员恢复已删除的项目',
      beforeData: { deletedAt: project.deletedAt, deleteReason: project.deleteReason },
      afterData: { deletedAt: null },
    });
    return { id, restored: true };
  }

  /** 项目只有在绑定流程的最后一个节点完成后才能标记为完成。 */
  private async assertProjectComplete(id: string) {
    const project = await this.prisma.project.findUnique({
      where: { id },
      select: {
        currentNodeCode: true,
        workflowVersion: { select: { nodes: { orderBy: { sequence: 'desc' }, take: 1, select: { code: true } } } },
      },
    });
    const finalNode = project?.workflowVersion?.nodes[0];
    if (!finalNode || project.currentNodeCode !== finalNode.code) {
      throw new ConflictException('项目只有在全部流程节点完成后才能标记为完成');
    }
  }

  private async ensureContract(id: string) {
    const contract = await this.prisma.contract.findFirst({ where: { id, deletedAt: null }, select: { id: true, contractNo: true } });
    if (!contract) throw new NotFoundException('所属合同不存在或已删除');
    return contract;
  }

  private async getEditable(id: string, userId: string, dataScope: DataScope) {
    const project = await this.prisma.project.findFirst({ where: { id, deletedAt: null, ...(await this.buildScopeWhere(userId, dataScope)) } });
    if (!project) throw new NotFoundException('项目不存在或无权操作');
    return project;
  }

  async assertAccess(id: string, userId: string, dataScope: DataScope) {
    return this.projectAccess.assertProjectAccess(id, userId, dataScope);
  }

  private async nextSequence(contractId: string, client: Prisma.TransactionClient | PrismaService = this.prisma) {
    const latest = await client.project.findFirst({ where: { contractId }, orderBy: { sequence: 'desc' }, select: { sequence: true } });
    return (latest?.sequence ?? 0) + 1;
  }

  /**
   * 导出的过滤条件（PRD 4.12）。
   * 复用列表用的 `buildScopeWhere`（内部走 ProjectAccessScopeService），口径一致。
   */
  async buildExportWhere(query: ProjectQueryDto, userId: string, dataScope: DataScope): Promise<Prisma.ProjectWhereInput> {
    return {
      deletedAt: null,
      // 与 list() 一致的 AND 组合，避免 `OR` 覆盖导致导出越权
      AND: [
        await this.buildScopeWhere(userId, dataScope),
        {
          ...(query.statusCode ? { statusCode: query.statusCode } : {}),
          ...(query.contractId ? { contractId: query.contractId } : {}),
          ...(query.keyword
            ? {
                OR: [
                  { projectNo: { contains: query.keyword, mode: 'insensitive' } },
                  { projectName: { contains: query.keyword, mode: 'insensitive' } },
                  { contract: { contractNo: { contains: query.keyword, mode: 'insensitive' } } },
                  { contract: { customer: { name: { contains: query.keyword, mode: 'insensitive' } } } },
                ],
              }
            : {}),
        },
      ],
    };
  }

  private async buildScopeWhere(userId: string, dataScope: DataScope): Promise<Prisma.ProjectWhereInput> {
    return this.projectAccess.buildProjectWhere(userId, dataScope);
  }
}


