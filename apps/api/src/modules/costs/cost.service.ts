import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataScope, Prisma } from '@prisma/client';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { parseCalendarDate } from '../../infrastructure/date/calendar-date';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { CreateCostDto, CostQueryDto, UpdateCostDto } from './dto/cost.dto';

/**
 * 成本登记在项目上，合同归属由项目带出（contractId 为便于按合同汇总的冗余列）。
 * 项目成本 = 该项目下的成本之和；合同成本 = 其下所有项目成本之和。
 */
@Injectable()
export class CostService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}

  async list(query: CostQueryDto, userId: string, dataScope: DataScope) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const where: Prisma.CostRecordWhereInput = {
      deletedAt: null,
      ...(await this.buildScopeWhere(userId, dataScope)),
      ...(query.contractId ? { contractId: query.contractId } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.keyword ? { costType: { contains: query.keyword, mode: 'insensitive' } } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.costRecord.findMany({
        where,
        orderBy: { incurredAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          contract: { select: { id: true, contractNo: true } },
          project: { select: { id: true, projectNo: true, projectName: true } },
        },
      }),
      this.prisma.costRecord.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async create(input: CreateCostDto, actorId: string) {
    const data = await this.toData(input);
    const cost = await this.prisma.costRecord.create({ data });
    await this.auditService.record({ actorId, action: 'CREATE', resourceType: 'CostRecord', resourceId: cost.id, afterData: cost });
    return cost;
  }

  async update(id: string, input: UpdateCostDto, actorId: string, dataScope: DataScope) {
    const before = await this.getEditable(id, actorId, dataScope);
    const data = await this.toData(input);
    const cost = await this.prisma.costRecord.update({ where: { id }, data });
    await this.auditService.record({ actorId, action: 'UPDATE', resourceType: 'CostRecord', resourceId: id, beforeData: before, afterData: cost });
    return cost;
  }

  /**
   * 软删除成本（PRD 7.2）：必须填原因并落库。
   *
   * 成本是财务数据，所以删除**不做级联、也不阻断** ——
   * 登记错了就该能改掉；删除后合同/项目的成本汇总会同步减少（既有行为）。
   */
  async remove(id: string, actorId: string, dataScope: DataScope, reason?: string) {
    const trimmed = reason?.trim();
    if (!trimmed) throw new BadRequestException('请填写删除原因');

    const before = await this.getEditable(id, actorId, dataScope);
    const cost = await this.prisma.costRecord.update({
      where: { id },
      data: { deletedAt: new Date(), deleteReason: trimmed, deletedBy: actorId },
    });
    await this.auditService.record({
      actorId,
      action: 'SOFT_DELETE',
      resourceType: 'CostRecord',
      resourceId: id,
      reason: trimmed,
      beforeData: before,
      afterData: { deletedAt: cost.deletedAt, deleteReason: cost.deleteReason },
    });
    return { id, deletedAt: cost.deletedAt };
  }

  /** 恢复被软删除的成本（PRD 7.1，仅管理员） */
  async restore(id: string, actorId: string, reason?: string) {
    const cost = await this.prisma.costRecord.findFirst({ where: { id, deletedAt: { not: null } } });
    if (!cost) throw new NotFoundException('该成本记录不在已删除状态，无需恢复');
    await this.prisma.costRecord.update({ where: { id }, data: { deletedAt: null, deleteReason: null, deletedBy: null } });
    await this.auditService.record({
      actorId,
      action: 'RESTORE',
      resourceType: 'CostRecord',
      resourceId: id,
      reason: reason?.trim() || '管理员恢复已删除的成本记录',
      beforeData: { deletedAt: cost.deletedAt, deleteReason: cost.deleteReason },
      afterData: { deletedAt: null },
    });
    return { id, restored: true };
  }

  /** 校验项目存在，并把合同归属按项目带出。 */
  private async toData(input: CreateCostDto | UpdateCostDto): Promise<Prisma.CostRecordUncheckedCreateInput> {
    const project = await this.prisma.project.findFirst({
      where: { id: input.projectId, deletedAt: null },
      select: { id: true, contractId: true },
    });
    if (!project) throw new NotFoundException('关联项目不存在或已删除');

    return {
      contractId: project.contractId,
      projectId: project.id,
      costType: input.costType,
      amount: input.amount,
      incurredAt: parseCalendarDate(input.incurredAt) ?? new Date(),
      note: input.note ?? null,
    };
  }

  private async getEditable(id: string, userId: string, dataScope: DataScope) {
    const cost = await this.prisma.costRecord.findFirst({ where: { id, deletedAt: null, ...(await this.buildScopeWhere(userId, dataScope)) } });
    if (!cost) throw new NotFoundException('成本不存在或无权操作');
    return cost;
  }

  /**
   * 导出的过滤条件（PRD 4.12）。
   * 复用列表用的 `buildScopeWhere`，与列表口径完全一致，避免导出越权。
   */
  async buildExportWhere(query: CostQueryDto, userId: string, dataScope: DataScope): Promise<Prisma.CostRecordWhereInput> {
    return {
      deletedAt: null,
      ...(await this.buildScopeWhere(userId, dataScope)),
      ...(query.contractId ? { contractId: query.contractId } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.keyword ? { costType: { contains: query.keyword, mode: 'insensitive' } } : {}),
    };
  }

  private async buildScopeWhere(userId: string, dataScope: DataScope): Promise<Prisma.CostRecordWhereInput> {
    if (dataScope === 'ALL') return {};
    if (dataScope === 'NONE') return { id: '__NO_ACCESS__' };
    if (dataScope === 'SELF' || dataScope === 'RELATED') {
      return { project: { OR: [{ ownerId: userId }, { contract: { ownerId: userId } }, { contract: { customer: { ownerId: userId } } }] } };
    }
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
    return { project: { OR: [{ ownerId: { in: ownerIds } }, { contract: { ownerId: { in: ownerIds } } }, { contract: { customer: { ownerId: { in: ownerIds } } } }] } };
  }
}


