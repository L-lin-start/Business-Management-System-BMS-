import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataScope, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

/**
 * 项目访问范围的唯一实现。
 *
 * SELF：项目负责人、合同负责人、当前节点负责人、历史经办人。
 * RELATED：在 SELF 基础上增加客户负责人。
 * DEPARTMENT：项目/合同/客户负责人属于本人部门。
 * DEPARTMENT_AND_DESCENDANTS：部门范围包含全部下属部门。
 */
@Injectable()
export class ProjectAccessScopeService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async buildProjectWhere(userId: string, dataScope: DataScope): Promise<Prisma.ProjectWhereInput> {
    if (dataScope === 'ALL') return {};
    if (dataScope === 'NONE') return { id: '__NO_ACCESS__' };

    if (dataScope === 'SELF' || dataScope === 'RELATED') {
      return { OR: await this.relatedProjectConditions(userId, dataScope === 'RELATED') };
    }

    const ownerIds = await this.departmentMemberIds(userId, dataScope);
    return {
      OR: [
        { ownerId: { in: ownerIds } },
        { contract: { ownerId: { in: ownerIds } } },
        { contract: { customer: { ownerId: { in: ownerIds } } } },
      ],
    };
  }

  /** 合同及合同级附属数据沿用同一项目关系：任一关联项目可见，则合同可见。 */
  async buildContractWhere(userId: string, dataScope: DataScope): Promise<Prisma.ContractWhereInput> {
    if (dataScope === 'ALL') return {};
    if (dataScope === 'NONE') return { id: '__NO_ACCESS__' };

    if (dataScope === 'SELF' || dataScope === 'RELATED') {
      const projectWhere = await this.buildProjectWhere(userId, dataScope);
      const direct: Prisma.ContractWhereInput[] = [{ ownerId: userId }];
      if (dataScope === 'RELATED') direct.push({ customer: { ownerId: userId } });
      return { OR: [...direct, { projects: { some: { AND: [{ deletedAt: null }, projectWhere] } } }] };
    }

    const ownerIds = await this.departmentMemberIds(userId, dataScope);
    const projectWhere = await this.buildProjectWhere(userId, dataScope);
    return {
      OR: [
        { ownerId: { in: ownerIds } },
        { customer: { ownerId: { in: ownerIds } } },
        { projects: { some: { AND: [{ deletedAt: null }, projectWhere] } } },
      ],
    };
  }

  async canAccessProject(projectId: string, userId: string, dataScope: DataScope) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null, ...(await this.buildProjectWhere(userId, dataScope)) },
      select: { id: true },
    });
    return project !== null;
  }

  async assertProjectAccess(projectId: string, userId: string, dataScope: DataScope) {
    const exists = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, projectNo: true, contractId: true, ownerId: true },
    });
    if (!exists) throw new NotFoundException('项目不存在或已删除');
    if (!(await this.canAccessProject(projectId, userId, dataScope))) {
      throw new ForbiddenException('无权访问该项目及其附属数据');
    }
    return exists;
  }

  async canAccessContract(contractId: string, userId: string, dataScope: DataScope) {
    const contract = await this.prisma.contract.findFirst({
      where: { id: contractId, deletedAt: null, ...(await this.buildContractWhere(userId, dataScope)) },
      select: { id: true },
    });
    return contract !== null;
  }

  async assertContractAccess(contractId: string, userId: string, dataScope: DataScope) {
    const exists = await this.prisma.contract.findFirst({
      where: { id: contractId, deletedAt: null },
      select: { id: true, contractNo: true },
    });
    if (!exists) throw new NotFoundException('合同不存在或已删除');
    if (!(await this.canAccessContract(contractId, userId, dataScope))) {
      throw new ForbiddenException('无权访问该合同及其附属数据');
    }
    return exists;
  }

  async visibleProjectIds(userId: string, dataScope: DataScope): Promise<string[]> {
    const projects = await this.prisma.project.findMany({
      where: { deletedAt: null, ...(await this.buildProjectWhere(userId, dataScope)) },
      select: { id: true },
    });
    return projects.map((project) => project.id);
  }

  private async relatedProjectConditions(userId: string, includeCustomerOwner: boolean): Promise<Prisma.ProjectWhereInput[]> {
    const roles = await this.prisma.userRole.findMany({
      where: { userId, role: { isActive: true } },
      select: { role: { select: { code: true } } },
    });
    const roleCodes = roles.map((item) => item.role.code);
    const nodes = roleCodes.length === 0
      ? []
      : await this.prisma.workflowNode.findMany({
          where: { assigneeType: 'ROLE', assigneeId: { in: roleCodes } },
          select: { code: true },
        });
    const nodeCodes = [...new Set(nodes.map((node) => node.code))];

    const conditions: Prisma.ProjectWhereInput[] = [
      { ownerId: userId },
      { contract: { ownerId: userId } },
      { nodeHistory: { some: { operatorId: userId } } },
    ];
    if (includeCustomerOwner) conditions.push({ contract: { customer: { ownerId: userId } } });
    if (nodeCodes.length > 0) conditions.push({ currentNodeCode: { in: nodeCodes } });
    return conditions;
  }

  private async departmentMemberIds(userId: string, dataScope: DataScope): Promise<string[]> {
    const memberships = await this.prisma.userDepartment.findMany({
      where: { userId },
      select: { departmentId: true },
    });
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

    const members = await this.prisma.userDepartment.findMany({
      where: { departmentId: { in: [...departmentIds] } },
      select: { userId: true },
    });
    return [...new Set(members.map((member) => member.userId))];
  }
}
