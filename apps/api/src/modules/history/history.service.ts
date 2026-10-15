import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';

export const HISTORY_RESOURCE_TYPES = ['Contract', 'Project'] as const;
export type HistoryResourceType = (typeof HISTORY_RESOURCE_TYPES)[number];

export function parseResourceType(value: string): HistoryResourceType {
  if ((HISTORY_RESOURCE_TYPES as readonly string[]).includes(value)) return value as HistoryResourceType;
  throw new BadRequestException(`不支持的历史类型：${value}`);
}

type RecordStatusChangeInput = {
  resourceType: HistoryResourceType;
  resourceId: string;
  fromStatusCode: string | null;
  toStatusCode: string;
  reason?: string | null;
  operatorId?: string | null;
};

/**
 * 状态与节点流转历史。
 *
 * 与 AuditLog 的分工：AuditLog 记录"发生了什么操作"，本服务专门回答
 * "这条记录的状态是怎么一步步变成现在这样的"，供详情页时间线使用。
 */
@Injectable()
export class HistoryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}

  /** 记录一次状态变化；状态未变化时不写记录。 */
  async recordStatusChange(input: RecordStatusChangeInput) {
    if (input.fromStatusCode === input.toStatusCode) return null;

    const record = await this.prisma.statusChangeHistory.create({
      data: {
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        fromStatusCode: input.fromStatusCode ?? null,
        toStatusCode: input.toStatusCode,
        reason: input.reason ?? null,
        operatorId: input.operatorId ?? null,
      },
    });

    // 状态变化同时进审计日志，满足"关键操作留痕"的要求
    await this.auditService.record({
      actorId: input.operatorId ?? undefined,
      action: 'STATUS_CHANGE',
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      ...(input.reason ? { reason: input.reason } : {}),
      beforeData: { statusCode: input.fromStatusCode },
      afterData: { statusCode: input.toStatusCode },
    });

    return record;
  }

  /** 某个合同/项目的状态变化历史，按时间正序（便于渲染时间线） */
  async listStatusHistory(resourceType: HistoryResourceType, resourceId: string, limit = 200) {
    const rows = await this.prisma.statusChangeHistory.findMany({
      where: { resourceType, resourceId },
      orderBy: { changedAt: 'asc' },
      take: Math.min(Math.max(limit, 1), 500),
      select: {
        id: true,
        fromStatusCode: true,
        toStatusCode: true,
        reason: true,
        changedAt: true,
        operator: { select: { id: true, displayName: true, username: true } },
      },
    });

    // 附上状态中文名，前端无需再查状态枚举
    const statuses = await this.prisma.statusDefinition.findMany({
      where: { moduleKey: resourceType === 'Contract' ? 'contract' : 'project' },
      select: { code: true, label: true, color: true },
    });
    const labelOf = (code: string | null) => (code ? statuses.find((item) => item.code === code)?.label ?? code : null);
    const colorOf = (code: string) => statuses.find((item) => item.code === code)?.color ?? null;

    return rows.map((row) => ({
      ...row,
      fromStatusLabel: labelOf(row.fromStatusCode),
      toStatusLabel: labelOf(row.toStatusCode),
      toStatusColor: colorOf(row.toStatusCode),
    }));
  }

  /** 项目节点流转历史，按时间正序 */
  async listNodeHistory(projectId: string, limit = 200) {
    const rows = await this.prisma.projectNodeHistory.findMany({
      where: { projectId },
      orderBy: { actionAt: 'asc' },
      take: Math.min(Math.max(limit, 1), 500),
      select: {
        id: true,
        workflowVersionId: true,
        fromNodeCode: true,
        toNodeCode: true,
        actionAt: true,
        deadlineAt: true,
        reason: true,
        note: true,
        operator: { select: { id: true, displayName: true, username: true } },
      },
    });

    // 节点编码仅用于内部关联；返回中文节点名称，避免把技术编码暴露给业务用户。
    const versionIds = [...new Set(rows.map((row) => row.workflowVersionId).filter((id): id is string => Boolean(id)))];
    const nodeCodes = [...new Set(rows.flatMap((row) => [row.fromNodeCode, row.toNodeCode]).filter((code): code is string => Boolean(code)))];
    const nodes = versionIds.length && nodeCodes.length
      ? await this.prisma.workflowNode.findMany({
        where: { versionId: { in: versionIds }, code: { in: nodeCodes } },
        select: { versionId: true, code: true, name: true },
      })
      : [];
    const nameOf = (versionId: string | null, code: string | null) => {
      if (!code) return null;
      return nodes.find((node) => node.versionId === versionId && node.code === code)?.name ?? '历史节点';
    };

    return rows.map((row) => ({
      ...row,
      fromNodeName: nameOf(row.workflowVersionId, row.fromNodeCode),
      toNodeName: nameOf(row.workflowVersionId, row.toNodeCode) ?? '历史节点',
    }));
  }

  /** 记录一次节点流转（阶段 1b 的流程推进将复用此方法） */
  async recordNodeTransition(input: {
    projectId: string;
    workflowVersionId?: string | null;
    fromNodeCode?: string | null;
    toNodeCode: string;
    operatorId?: string | null;
    deadlineAt?: Date | null;
    reason?: string | null;
    note?: string | null;
  }) {
    return this.prisma.projectNodeHistory.create({
      data: {
        projectId: input.projectId,
        workflowVersionId: input.workflowVersionId ?? null,
        fromNodeCode: input.fromNodeCode ?? null,
        toNodeCode: input.toNodeCode,
        operatorId: input.operatorId ?? null,
        deadlineAt: input.deadlineAt ?? null,
        reason: input.reason ?? null,
        note: input.note ?? null,
      },
    });
  }
}
