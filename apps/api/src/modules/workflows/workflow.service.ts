import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { CreateWorkflowTemplateDto, CreateWorkflowVersionDto, UpdateWorkflowTemplateDto, WorkflowNodeDto } from './dto/workflow.dto';
import { generateInternalCode } from '../../infrastructure/identifiers/internal-code';

/** 节点未显式指定统计状态时的兜底值 */
const DEFAULT_NODE_STATISTICS_CODE = 'IN_PROGRESS';
/** 项目类型匹配不到专用模板时使用的模板名 */
const FALLBACK_TEMPLATE_NAME = '通用流程';
/** 重排前把全部序号移到业务区间之外，避免唯一索引在交换位置时产生瞬时冲突 */
const REORDER_SEQUENCE_OFFSET = 10000;

type NodeSettings = { statisticsCode?: string } & Record<string, unknown>;

function readStatisticsCode(settings: Prisma.JsonValue | null | undefined): string {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const value = (settings as NodeSettings).statisticsCode;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return DEFAULT_NODE_STATISTICS_CODE;
}

/**
 * 流程模板与版本（系统 B 的配置能力）。
 *
 * 版本化规则（PRD 4.4）：
 *   - 修改流程 = 新建 DRAFT 版本，不在已发布版本上直接改
 *   - 发布新版本时把同模板下的旧 PUBLISHED 版本置为 LOCKED（老项目仍按老版本走）
 *   - 项目在创建时绑定当时的已发布版本，此后不随模板更新而改变
 */
@Injectable()
export class WorkflowService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}

  /* ---------------- 读取（系统 A 与系统 B 共用） ---------------- */

  async listTemplates(moduleKey = 'project') {
    // 自愈：修复前创建的模板可能没有任何版本（当时新建模板不会自动建版本），
    // 这种模板在界面上既看不到节点也无从配置，这里补一个空白草稿版本。
    const emptyTemplates = await this.prisma.workflowTemplate.findMany({
      where: { moduleKey, versions: { none: {} } },
      select: { id: true, name: true },
    });
    for (const template of emptyTemplates) {
      await this.prisma.workflowVersion.create({ data: { templateId: template.id, version: 1, status: 'DRAFT' } });
      await this.auditService.record({
        action: 'CREATE',
        resourceType: 'WorkflowVersion',
        reason: `模板「${template.name}」缺少版本，已自动补建空白草稿版本 v1`,
        afterData: { templateId: template.id, version: 1 },
      });
    }

    return this.prisma.workflowTemplate.findMany({
      where: { moduleKey },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
      include: {
        versions: {
          orderBy: { version: 'desc' },
          select: { id: true, version: true, status: true, publishedAt: true, _count: { select: { nodes: true, projects: true } } },
        },
      },
    });
  }

  async getVersion(versionId: string) {
    const version = await this.prisma.workflowVersion.findUnique({
      where: { id: versionId },
      include: {
        template: true,
        nodes: { orderBy: { sequence: 'asc' } },
        _count: { select: { projects: true } },
      },
    });
    if (!version) throw new NotFoundException('流程版本不存在');
    return version;
  }

  /** 项目类型 → 已发布版本。匹配不到专用模板时退回「通用流程」。 */
  async findPublishedVersionForProjectType(projectType?: string | null) {
    const type = (projectType ?? '').trim();
    if (type) {
      const matched = await this.prisma.workflowTemplate.findFirst({
        where: { moduleKey: 'project', isActive: true, name: type },
        select: { id: true },
      });
      if (matched) {
        const version = await this.publishedVersionOf(matched.id);
        if (version) return version;
      }
    }

    const fallback = await this.prisma.workflowTemplate.findFirst({
      where: { moduleKey: 'project', isActive: true, name: FALLBACK_TEMPLATE_NAME },
      select: { id: true },
    });
    return fallback ? this.publishedVersionOf(fallback.id) : null;
  }

  /** 某项目类型对应的流程节点列表（供系统 A 展示完整流程） */
  async listPublishedNodes(projectType?: string | null) {
    const version = await this.findPublishedVersionForProjectType(projectType);
    if (!version) return { version: null, nodes: [] };
    const nodes = await this.prisma.workflowNode.findMany({
      where: { versionId: version.id },
      orderBy: { sequence: 'asc' },
      select: { code: true, name: true, sequence: true, nodeType: true, assigneeType: true, assigneeId: true, deadlineDays: true, warningDays: true, settings: true },
    });
    return {
      version: { id: version.id, version: version.version, templateName: version.template.name },
      nodes: nodes.map((node) => ({ ...node, statisticsCode: readStatisticsCode(node.settings) })),
    };
  }

  /* ---------------- 模板与版本维护 ---------------- */

  async createTemplate(input: CreateWorkflowTemplateDto, actorId?: string) {
    const duplicated = await this.prisma.workflowTemplate.findFirst({
      where: { moduleKey: input.moduleKey, name: input.name },
      select: { id: true },
    });
    if (duplicated) throw new ConflictException('同模块下已存在同名流程模板');

    // 新模板直接带一个空白草稿版本：否则模板下没有版本，既无法配置节点也无从发布
    const template = await this.prisma.workflowTemplate.create({
      data: {
        moduleKey: input.moduleKey,
        name: input.name,
        description: input.description ?? null,
        versions: { create: { version: 1, status: 'DRAFT' } },
      },
      include: { versions: { select: { id: true, version: true, status: true } } },
    });
    await this.auditService.record({
      actorId,
      action: 'CREATE',
      resourceType: 'WorkflowTemplate',
      resourceId: template.id,
      reason: `新建模板「${template.name}」并创建空白草稿版本 v1`,
      afterData: template,
    });
    return template;
  }

  async updateTemplate(id: string, input: UpdateWorkflowTemplateDto, actorId?: string) {
    const before = await this.prisma.workflowTemplate.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('流程模板不存在');

    const template = await this.prisma.workflowTemplate.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description || null } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await this.auditService.record({ actorId, action: 'UPDATE', resourceType: 'WorkflowTemplate', resourceId: id, beforeData: before, afterData: template });
    return template;
  }

  /**
   * 删除流程模板（含其下全部版本与节点）。
   *
   * 三道拦截，避免把在用的流程删掉导致项目失去节点定义：
   *   1. **预置模板**（isSystem）不允许删除 —— 项目按「项目类型」匹配同名模板，
   *      其中「通用流程」还是代码里写死的兜底（`FALLBACK_TEMPLATE_NAME`）；
   *   2. **已有项目绑定**该模板下任一版本时不允许删除 —— 外键是 SET NULL，
   *      直接删会让在用项目静默失去流程，必须在源头拦住；
   *   3. 模板不存在时返回 404。
   *
   * 用户自己新建、且没有被项目使用的模板可以正常删除（DRAFT 版本 + 无绑定项目）。
   */
  async deleteTemplate(id: string, actorId?: string) {
    const template = await this.prisma.workflowTemplate.findUnique({
      where: { id },
      include: {
        versions: {
          select: {
            id: true,
            version: true,
            status: true,
            _count: { select: { nodes: true, projects: true } },
          },
          orderBy: { version: 'asc' },
        },
      },
    });
    if (!template) throw new NotFoundException('流程模板不存在');

    if (template.isSystem) {
      throw new ConflictException(
        `「${template.name}」是系统预置模板，不能删除。如果不再使用，可以改名或停用；` +
          `如需调整节点，请基于它新建版本（PRD 4.4 流程版本化）。`,
      );
    }

    const boundProjects = template.versions.reduce((sum, item) => sum + item._count.projects, 0);
    if (boundProjects > 0) {
      throw new ConflictException(
        `「${template.name}」下已有 ${boundProjects} 个项目在使用该流程，不能删除。` +
          `请先确认这些项目走完或改绑流程后再试。`,
      );
    }

    const nodeCount = template.versions.reduce((sum, item) => sum + item._count.nodes, 0);
    // 版本与节点是 ON DELETE CASCADE，显式在事务里删模板即可级联清掉
    await this.prisma.$transaction(async (tx) => {
      await tx.workflowTemplate.delete({ where: { id } });
    });

    await this.auditService.record({
      actorId,
      action: 'DELETE',
      resourceType: 'WorkflowTemplate',
      resourceId: id,
      reason: `删除流程模板「${template.name}」（含 ${template.versions.length} 个版本、${nodeCount} 个节点）`,
      beforeData: {
        name: template.name,
        moduleKey: template.moduleKey,
        versions: template.versions.map((item) => ({ version: item.version, status: item.status, nodes: item._count.nodes })),
      },
    });
    return { id, name: template.name, deletedVersions: template.versions.length, deletedNodes: nodeCount };
  }

  /** 新建版本：可用 copyFromVersionId 从既有版本复制节点（老流程锁定的落地方式） */
  async createVersion(templateId: string, input: CreateWorkflowVersionDto, actorId?: string) {
    const template = await this.prisma.workflowTemplate.findUnique({ where: { id: templateId }, select: { id: true, name: true } });
    if (!template) throw new NotFoundException('流程模板不存在');

    const latest = await this.prisma.workflowVersion.findFirst({
      where: { templateId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const nextVersion = (latest?.version ?? 0) + 1;

    const sourceNodes = input.copyFromVersionId
      ? await this.prisma.workflowNode.findMany({ where: { versionId: input.copyFromVersionId }, orderBy: { sequence: 'asc' } })
      : [];

    const version = await this.prisma.workflowVersion.create({
      data: {
        templateId,
        version: nextVersion,
        status: 'DRAFT',
        ...(sourceNodes.length > 0
          ? {
              nodes: {
                create: sourceNodes.map((node) => ({
                  code: node.code,
                  name: node.name,
                  nodeType: node.nodeType,
                  sequence: node.sequence,
                  assigneeType: node.assigneeType,
                  assigneeId: node.assigneeId,
                  deadlineDays: node.deadlineDays,
                  warningDays: node.warningDays,
                  ...(node.settings === null || node.settings === undefined ? {} : { settings: node.settings as Prisma.InputJsonValue }),
                })),
              },
            }
          : {}),
      },
      include: { nodes: { orderBy: { sequence: 'asc' } } },
    });

    await this.auditService.record({
      actorId,
      action: 'CREATE',
      resourceType: 'WorkflowVersion',
      resourceId: version.id,
      reason: `模板「${template.name}」新建版本 v${nextVersion}${sourceNodes.length > 0 ? `（复制自 ${sourceNodes.length} 个节点）` : ''}`,
      afterData: { templateId, version: nextVersion, nodeCount: sourceNodes.length },
    });
    return version;
  }

  /** 发布版本：同模板下其余 PUBLISHED 版本转为 LOCKED，老项目继续按老版本走 */
  async publishVersion(versionId: string, actorId?: string) {
    const version = await this.prisma.workflowVersion.findUnique({
      where: { id: versionId },
      include: { template: { select: { id: true, name: true } }, nodes: { select: { id: true } } },
    });
    if (!version) throw new NotFoundException('流程版本不存在');
    if (version.status === 'PUBLISHED') return version;
    if (version.nodes.length === 0) throw new BadRequestException('该版本没有节点，无法发布');

    const published = await this.prisma.$transaction(async (tx) => {
      await tx.workflowVersion.updateMany({
        where: { templateId: version.templateId, status: 'PUBLISHED', id: { not: versionId } },
        data: { status: 'LOCKED' },
      });
      return tx.workflowVersion.update({
        where: { id: versionId },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
        include: { nodes: { orderBy: { sequence: 'asc' } } },
      });
    });

    await this.auditService.record({
      actorId,
      action: 'PUBLISH',
      resourceType: 'WorkflowVersion',
      resourceId: versionId,
      reason: `模板「${version.template.name}」发布 v${version.version}`,
      afterData: { version: version.version, nodeCount: version.nodes.length },
    });
    return published;
  }

  /* ---------------- 节点维护（仅 DRAFT 版本可改） ---------------- */

  async createNode(versionId: string, input: WorkflowNodeDto, actorId?: string) {
    const generatedCode = generateInternalCode('NODE');
    const node = await this.prisma.$transaction(async (tx) => {
      await this.lockDraftVersion(tx, versionId, '新增节点');
      const existing = await tx.workflowNode.findMany({
        where: { versionId },
        orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, code: true },
      });
      const targetSequence = this.clampSequence(input.sequence, existing.length + 1);
      await this.moveSequencesOutOfRange(tx, versionId);
      const created = await tx.workflowNode.create({
        data: {
          versionId,
          code: generatedCode,
          name: input.name,
          nodeType: input.nodeType,
          sequence: targetSequence,
          assigneeType: input.assigneeType ?? null,
          assigneeId: input.assigneeId ?? null,
          deadlineDays: input.deadlineDays ?? null,
          warningDays: input.warningDays ?? null,
          settings: { ...(input.settings ?? {}), statisticsCode: input.statisticsCode ?? DEFAULT_NODE_STATISTICS_CODE } as Prisma.InputJsonValue,
        },
      });
      const orderedIds = existing.map((item) => item.id);
      orderedIds.splice(targetSequence - 1, 0, created.id);
      await this.persistSequenceOrder(tx, orderedIds);
      return tx.workflowNode.findUniqueOrThrow({ where: { id: created.id } });
    });
    await this.auditService.record({ actorId, action: 'CREATE', resourceType: 'WorkflowNode', resourceId: node.id, reason: `版本 ${versionId} 新增节点`, afterData: node });
    return node;
  }

  async updateNode(nodeId: string, input: WorkflowNodeDto, actorId?: string) {
    const current = await this.prisma.workflowNode.findUnique({ where: { id: nodeId }, select: { versionId: true } });
    if (!current) throw new NotFoundException('流程节点不存在');
    const { before, node } = await this.prisma.$transaction(async (tx) => {
      await this.lockDraftVersion(tx, current.versionId, '修改节点');
      const nodes = await tx.workflowNode.findMany({
        where: { versionId: current.versionId },
        orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      const before = nodes.find((item) => item.id === nodeId);
      if (!before) throw new NotFoundException('流程节点不存在');
      const orderedIds = nodes.filter((item) => item.id !== nodeId).map((item) => item.id);
      const targetSequence = this.clampSequence(input.sequence, orderedIds.length + 1);
      orderedIds.splice(targetSequence - 1, 0, nodeId);
      await this.moveSequencesOutOfRange(tx, current.versionId);
      await tx.workflowNode.update({
        where: { id: nodeId },
        data: {
          name: input.name,
          nodeType: input.nodeType,
          assigneeType: input.assigneeType ?? null,
          assigneeId: input.assigneeId ?? null,
          deadlineDays: input.deadlineDays ?? null,
          warningDays: input.warningDays ?? null,
          settings: { ...(input.settings ?? {}), statisticsCode: input.statisticsCode ?? DEFAULT_NODE_STATISTICS_CODE } as Prisma.InputJsonValue,
        },
      });
      await this.persistSequenceOrder(tx, orderedIds);
      const node = await tx.workflowNode.findUniqueOrThrow({ where: { id: nodeId } });
      return { before, node };
    });
    await this.auditService.record({ actorId, action: 'UPDATE', resourceType: 'WorkflowNode', resourceId: nodeId, beforeData: before, afterData: node });
    return node;
  }

  async deleteNode(nodeId: string, actorId?: string) {
    const current = await this.prisma.workflowNode.findUnique({ where: { id: nodeId }, select: { versionId: true } });
    if (!current) throw new NotFoundException('流程节点不存在');
    const before = await this.prisma.$transaction(async (tx) => {
      await this.lockDraftVersion(tx, current.versionId, '删除节点');
      const nodes = await tx.workflowNode.findMany({
        where: { versionId: current.versionId },
        orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      const before = nodes.find((item) => item.id === nodeId);
      if (!before) throw new NotFoundException('流程节点不存在');
      await tx.workflowNode.delete({ where: { id: nodeId } });
      const orderedIds = nodes.filter((item) => item.id !== nodeId).map((item) => item.id);
      await this.moveSequencesOutOfRange(tx, current.versionId);
      await this.persistSequenceOrder(tx, orderedIds);
      return before;
    });
    await this.auditService.record({ actorId, action: 'DELETE', resourceType: 'WorkflowNode', resourceId: nodeId, beforeData: before });
    return { id: nodeId };
  }

  private clampSequence(requested: number, itemCount: number) {
    return Math.max(1, Math.min(requested, itemCount));
  }

  /** 锁定版本行，使同一草稿版本的并发增删改按顺序执行。 */
  private async lockDraftVersion(tx: Prisma.TransactionClient, versionId: string, action: string) {
    await tx.$queryRaw`SELECT "id" FROM "public"."WorkflowVersion" WHERE "id" = ${versionId} FOR UPDATE`;
    const version = await tx.workflowVersion.findUnique({ where: { id: versionId }, select: { status: true, version: true } });
    if (!version) throw new NotFoundException('流程版本不存在');
    if (version.status !== 'DRAFT') {
      throw new ConflictException(`v${version.version} 已发布并锁定，不能${action}。请新建版本后再修改（PRD 4.4：老流程锁定）。`);
    }
    return version;
  }

  private async moveSequencesOutOfRange(tx: Prisma.TransactionClient, versionId: string) {
    await tx.workflowNode.updateMany({
      where: { versionId },
      data: { sequence: { increment: REORDER_SEQUENCE_OFFSET } },
    });
  }

  private async persistSequenceOrder(tx: Prisma.TransactionClient, orderedIds: string[]) {
    for (const [index, id] of orderedIds.entries()) {
      await tx.workflowNode.update({ where: { id }, data: { sequence: index + 1 } });
    }
  }

  private publishedVersionOf(templateId: string) {
    return this.prisma.workflowVersion.findFirst({
      where: { templateId, status: 'PUBLISHED' },
      orderBy: { version: 'desc' },
      include: { template: { select: { id: true, name: true } } },
    });
  }
}
