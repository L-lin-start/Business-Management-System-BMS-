import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataScope, Prisma } from '@prisma/client';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { VERSION_CONFLICT_MESSAGE } from '../../infrastructure/concurrency/optimistic-lock';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { HistoryService } from '../history/history.service';
import { NodeAssigneeService } from './node-assignee.service';
import { WorkflowService } from './workflow.service';
import { ContractStatusService } from '../contracts/contract-status.service';
import { ProjectAccessScopeService } from '../../infrastructure/project-access/project-access-scope.service';

type TransitionInput = {
  /** 目标节点编码；缺省表示推进到当前节点的下一个节点 */
  toNodeCode?: string;
  /** 客户端读到的项目版本号，用于乐观锁 */
  version?: number;
  reason?: string;
  note?: string;
};

/**
 * 项目节点推进。
 *
 * 规则（阶段 1b + 阶段 3.6）：
 *   - 项目必须已绑定流程版本；未绑定的项目按项目类型绑定当前已发布版本
 *   - 目标节点必须属于该项目绑定的版本（保证老项目走老流程）
 *   - 只能推进到下一个节点，不允许跳号（回退由后续「回退节点」能力单独处理）
 *   - **只有当前节点的负责人（按角色）能推进**；系统管理员与总经理不受限制
 *   - 推进成功后同步项目状态为节点的统计状态（PRD 5.5），并写节点历史 + 状态历史 + 审计
 *   - 使用乐观锁：version 不一致直接 409，避免两人同时点
 */
@Injectable()
export class TransitionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(HistoryService) private readonly historyService: HistoryService,
    @Inject(WorkflowService) private readonly workflowService: WorkflowService,
    @Inject(NodeAssigneeService) private readonly nodeAssignee: NodeAssigneeService,
    @Inject(ContractStatusService) private readonly contractStatusService: ContractStatusService,
    @Inject(ProjectAccessScopeService) private readonly projectAccess: ProjectAccessScopeService,
  ) {}

  /** 项目可推进到的节点（当前节点的下一个 / 全部候选） */
  async availableTransitions(projectId: string, userId: string, dataScope: DataScope) {
    const project = await this.getAccessibleProject(projectId, userId, dataScope);
    const context = await this.resolveContext(project);
    if (!context) {
      return {
        currentNode: null,
        nextNode: null,
        nodes: [],
        boundVersion: null,
        reason: '该项目尚未绑定流程',
        canTransition: false,
        transitionBlockedReason: null,
      };
    }

    // 与 transition 保持一致：尚未进入任何节点（历史项目/刚解绑）时，下一步是流程首节点
    const currentIndex = context.currentNode ? context.nodes.findIndex((node) => node.code === context.currentNode?.code) : -1;
    const nextNode = currentIndex >= 0 ? context.nodes[currentIndex + 1] ?? null : context.nodes[0] ?? null;

    // 给每个节点补上"归谁办"的可读信息，前端直接展示（项目负责人由此看到全流程分工）
    const decoratedNodes = await this.nodeAssignee.decorateNodes(context.nodes);
    const currentNodeDisplay = decoratedNodes.find((node) => node.code === context.currentNode?.code) ?? null;

    // 前端据此决定"推进"按钮是否可点，避免点了才被拒
    const permission = await this.nodeAssignee.checkTransitionPermission(userId, context.currentNode);

    return {
      currentNode: context.currentNode
        ? {
            code: context.currentNode.code,
            name: context.currentNode.name,
            sequence: context.currentNode.sequence,
            assignee: currentNodeDisplay?.assignee ?? null,
          }
        : null,
      nextNode: nextNode
        ? {
            code: nextNode.code,
            name: nextNode.name,
            sequence: nextNode.sequence,
            assignee: decoratedNodes.find((node) => node.code === nextNode.code)?.assignee ?? null,
          }
        : null,
      nodes: decoratedNodes.map((node) => ({
        code: node.code,
        name: node.name,
        sequence: node.sequence,
        assigneeType: node.assigneeType,
        assigneeId: node.assigneeId,
        assignee: node.assignee,
        deadlineDays: node.deadlineDays,
        warningDays: node.warningDays,
      })),
      boundVersion: { id: context.version.id, version: context.version.version, templateName: context.templateName },
      /** 当前用户能否推进（false 时界面禁用按钮并显示 transitionBlockedReason） */
      canTransition: permission.canTransition,
      transitionBlockedReason: permission.reason,
      reason: null,
    };
  }

  /** 推进到下一个节点（或指定节点） */
  async transition(projectId: string, input: TransitionInput, userId: string, dataScope: DataScope) {
    const project = await this.getAccessibleProject(projectId, userId, dataScope);

    // 乐观锁：并发推进时只允许一个成功
    if (input.version !== undefined && project.version !== input.version) {
      throw new ConflictException(VERSION_CONFLICT_MESSAGE);
    }

    const context = await this.resolveContext(project);
    if (!context) throw new BadRequestException('该项目尚未绑定流程，无法推进节点');

    const { nodes, currentNode } = context;
    const currentIndex = currentNode ? nodes.findIndex((node) => node.code === currentNode.code) : -1;
    const sequentialNext = currentIndex >= 0 ? nodes[currentIndex + 1] ?? null : nodes[0] ?? null;
    const nextNode = input.toNodeCode
      ? nodes.find((node) => node.code === input.toNodeCode)
      : sequentialNext;

    if (input.toNodeCode && !nextNode) {
      throw new BadRequestException(`节点 ${input.toNodeCode} 不属于本项目绑定的流程版本`);
    }
    if (!nextNode) {
      throw new BadRequestException('已经是最后一个节点，无需继续推进');
    }
    // 只允许推进到下一个节点：显式指定也必须是下一个，避免"指定任意节点"绕过顺序检查
    if (input.toNodeCode && sequentialNext && nextNode.code !== sequentialNext.code) {
      throw new BadRequestException(`只能推进到下一个节点「${sequentialNext.name}」，不能直接跳到「${nextNode.name}」`);
    }

    // 节点分派校验：只有**当前节点**的负责人（按角色）能把它推到下一步，交接给下一位。
    // 不校验的话，有 project.transition 权限的人可以推任何节点，节点上配的负责人形同虚设。
    const permission = await this.nodeAssignee.checkTransitionPermission(userId, currentNode);
    if (!permission.canTransition) {
      throw new ForbiddenException(permission.reason ?? '你不是当前节点的负责人，无法推进');
    }

    const now = new Date();
    const deadlineAt = nextNode.deadlineDays ? new Date(now.getTime() + nextNode.deadlineDays * 24 * 60 * 60 * 1000) : null;
    const statisticsCode = readStatisticsCode(nextNode.settings);

    const result = await this.prisma.$transaction(async (tx) => {
      const guarded = await tx.project.updateMany({
        where: { id: projectId, version: project.version },
        data: {
          workflowVersionId: context.version.id,
          currentNodeCode: nextNode.code,
          currentNodeEnteredAt: now,
          statusCode: statisticsCode,
          version: { increment: 1 },
        },
      });
      if (guarded.count === 0) throw new ConflictException(VERSION_CONFLICT_MESSAGE);

      const updated = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
      await tx.projectNodeHistory.create({
        data: {
          projectId,
          workflowVersionId: context.version.id,
          fromNodeCode: currentNode?.code ?? null,
          toNodeCode: nextNode.code,
          operatorId: userId,
          actionAt: now,
          deadlineAt,
          reason: input.reason ?? null,
          note: input.note ?? null,
        },
      });
      return { updated, statisticsCode };
    });
    const updatedProject = result.updated;

    await this.auditService.record({
      actorId: userId,
      action: 'NODE_TRANSITION',
      resourceType: 'Project',
      resourceId: projectId,
      reason: input.reason ?? `节点推进：${currentNode?.name ?? '（未开始）'} → ${nextNode.name}`,
      beforeData: { currentNodeCode: project.currentNodeCode, statusCode: project.statusCode },
      afterData: { currentNodeCode: nextNode.code, statusCode: statisticsCode },
    });
    await this.historyService.recordStatusChange({
      resourceType: 'Project',
      resourceId: projectId,
      fromStatusCode: project.statusCode,
      toStatusCode: statisticsCode,
      reason: input.reason ?? `节点推进到「${nextNode.name}」`,
      operatorId: userId,
    });
    await this.contractStatusService.reconcile(project.contractId, userId, '项目流程节点变更后自动同步合同状态');

    return {
      project: updatedProject,
      fromNode: currentNode ? { code: currentNode.code, name: currentNode.name } : null,
      toNode: { code: nextNode.code, name: nextNode.name, sequence: nextNode.sequence },
      statusCode: statisticsCode,
      deadlineAt,
    };
  }

  /** 解析项目绑定的流程版本与节点；未绑定的项目按项目类型绑定已发布版本 */
  private async resolveContext(project: {
    id: string;
    projectType: string | null;
    workflowVersionId: string | null;
    currentNodeCode: string | null;
  }) {
    let versionId = project.workflowVersionId;
    if (!versionId) {
      const published = await this.workflowService.findPublishedVersionForProjectType(project.projectType);
      if (!published) return null;
      versionId = published.id;
    }

    const version = await this.prisma.workflowVersion.findUnique({
      where: { id: versionId },
      include: { template: { select: { name: true } }, nodes: { orderBy: { sequence: 'asc' } } },
    });
    if (!version || version.status === 'DRAFT') {
      // 绑定的版本已不可用（例如被删除或仍在草稿），退回按项目类型重新解析
      const published = await this.workflowService.findPublishedVersionForProjectType(project.projectType);
      if (!published) return null;
      const fallback = await this.prisma.workflowVersion.findUnique({
        where: { id: published.id },
        include: { template: { select: { name: true } }, nodes: { orderBy: { sequence: 'asc' } } },
      });
      if (!fallback) return null;
      return {
        version: { id: fallback.id, version: fallback.version },
        templateName: fallback.template.name,
        nodes: fallback.nodes,
        currentNode: project.currentNodeCode ? fallback.nodes.find((node) => node.code === project.currentNodeCode) ?? null : null,
      };
    }

    return {
      version: { id: version.id, version: version.version },
      templateName: version.template.name,
      nodes: version.nodes,
      currentNode: project.currentNodeCode ? version.nodes.find((node) => node.code === project.currentNodeCode) ?? null : null,
    };
  }

  private async getAccessibleProject(projectId: string, userId: string, dataScope: DataScope) {
    const scopeWhere = await this.buildScopeWhere(userId, dataScope);
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null, ...scopeWhere },
      select: { id: true, contractId: true, projectType: true, workflowVersionId: true, currentNodeCode: true, statusCode: true, version: true },
    });
    if (!project) throw new NotFoundException('项目不存在或无权操作');
    return project;
  }

  private async buildScopeWhere(userId: string, dataScope: DataScope): Promise<Prisma.ProjectWhereInput> {
    return this.projectAccess.buildProjectWhere(userId, dataScope);
  }
}

/** 节点配置里的统计状态编码，缺省视为进行中 */
function readStatisticsCode(settings: Prisma.JsonValue | null | undefined): string {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const value = (settings as { statisticsCode?: unknown }).statisticsCode;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return 'IN_PROGRESS';
}
