import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { CreateDepartmentDto, UpdateDepartmentDto } from './dto/department.dto';
import { CreateRoleDto, UpdateRoleDto, UpdateRolePermissionsDto } from './dto/role.dto';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';
import { CreateFieldDefinitionDto, UpdateFieldDefinitionDto } from './dto/field-definition.dto';
import { generateInternalCode } from '../../infrastructure/identifiers/internal-code';

type DepartmentRow = {
  id: string;
  name: string;
  code: string;
  parentId: string | null;
  managerId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  manager: { id: string; displayName: string } | null;
  _count: { members: number; children: number };
};

type DepartmentNode = DepartmentRow & { children: DepartmentNode[] };

@Injectable()
export class AdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}

  async listDepartmentTree() {
    const rows = (await this.prisma.department.findMany({
      orderBy: [{ name: 'asc' }],
      include: {
        manager: { select: { id: true, displayName: true } },
        _count: { select: { members: true, children: true } },
      },
    })) as DepartmentRow[];

    const nodes = new Map<string, DepartmentNode>();
    for (const row of rows) nodes.set(row.id, { ...row, children: [] });

    const roots: DepartmentNode[] = [];
    for (const node of nodes.values()) {
      if (node.parentId && nodes.has(node.parentId)) {
        nodes.get(node.parentId)?.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  async createDepartment(input: CreateDepartmentDto, actorId?: string) {
    try {
      const department = await this.prisma.department.create({
        data: {
          name: input.name,
          code: generateInternalCode('DEPT'),
          ...(input.parentId ? { parentId: input.parentId } : {}),
          ...(input.managerId ? { managerId: input.managerId } : {}),
        },
      });
      await this.auditService.record({ actorId, action: 'CREATE', resourceType: 'Department', resourceId: department.id, afterData: department });
      return department;
    } catch (error) {
      this.rethrowConflict(error, '部门创建失败，请检查部门信息后重试');
    }
  }

  async updateDepartment(id: string, input: UpdateDepartmentDto, actorId?: string) {
    const before = await this.ensureDepartment(id);

    // 改上级时必须防环：把部门挂到自己的后代下会让组织树形成循环，界面渲染会无限递归。
    if (input.parentId !== undefined && input.parentId) {
      if (input.parentId === id) {
        throw new ConflictException('不能把部门的上级设成它自己');
      }
      const descendants = await this.collectDescendantIds(id);
      if (descendants.has(input.parentId)) {
        throw new ConflictException('不能把部门移动到它自己的下级部门里，否则组织架构会形成循环');
      }
    }

    try {
      const department = await this.prisma.department.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          // parentId 允许显式传空串来"提升为顶层部门"
          ...(input.parentId !== undefined ? { parentId: input.parentId || null } : {}),
          ...(input.managerId !== undefined ? { managerId: input.managerId || null } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
      await this.auditService.record({ actorId, action: 'UPDATE', resourceType: 'Department', resourceId: id, beforeData: before, afterData: department });
      return department;
    } catch (error) {
      this.rethrowConflict(error, '部门关系无效或更新失败');
    }
  }

  /** 收集某部门的全部后代 id（用于防止把部门挂到自己的后代下形成环） */
  private async collectDescendantIds(rootId: string): Promise<Set<string>> {
    const all = await this.prisma.department.findMany({ select: { id: true, parentId: true } });
    const childrenOf = new Map<string | null, string[]>();
    for (const item of all) {
      const list = childrenOf.get(item.parentId) ?? [];
      list.push(item.id);
      childrenOf.set(item.parentId, list);
    }
    const result = new Set<string>();
    const queue = [...(childrenOf.get(rootId) ?? [])];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (result.has(current)) continue;
      result.add(current);
      queue.push(...(childrenOf.get(current) ?? []));
    }
    return result;
  }

  /**
   * 删除部门。
   *
   * 采用**物理删除**（部门表没有 deletedAt，且它不是业务数据，不需要软删除保留历史），
   * 但必须先清空前置条件，否则会把组织结构和人员归属搞乱：
   *   - 有**子部门**：删掉父部门会让子部门变成游离节点（外键是 SET NULL），要求先处理子部门；
   *   - 有**成员**：`UserDepartment` 的外键是 ON DELETE CASCADE，直删会**静默解除成员归属**，
   *     用户的部门信息会凭空少一个，所以要求先把成员调走；
   *   - **同级最后一个部门**不允许删除，否则该层级会被删空。
   *
   * 说明：组织架构允许存在多个平级部门（PRD 5.1「支持多部门」），
   * 因此**不能因为"没有上级"就禁止删除** —— 只有当它是同一父级下的最后一个时才拦。
   * 例如「总公司 / 销售部 / 财务部 / 技术部」四个平级部门，可以逐个删掉三个。
   *
   * 拒绝时都给出可操作的说明，而不是一句"不能删"。
   */
  async deleteDepartment(id: string, actorId?: string) {
    const department = await this.prisma.department.findUnique({
      where: { id },
      include: {
        _count: { select: { children: true, members: true } },
        parent: { select: { id: true, name: true } },
      },
    });
    if (!department) throw new NotFoundException('部门不存在');

    if (department._count.children > 0) {
      throw new ConflictException(
        `「${department.name}」下还有 ${department._count.children} 个子部门，不能删除。` +
          `请先删除或移走这些子部门。`,
      );
    }

    if (department._count.members > 0) {
      throw new ConflictException(
        `「${department.name}」下还有 ${department._count.members} 名成员，不能删除。` +
          `请先在「用户账号」里把这些成员改到其它部门。`,
      );
    }

    // 同级（同一个上级）还剩几个：只剩它自己时不允许删，避免把这一层删空
    const siblings = await this.prisma.department.count({ where: { parentId: department.parentId } });
    if (siblings <= 1) {
      const levelLabel = department.parent ? `「${department.parent.name}」下` : '组织架构根层级';
      throw new ConflictException(
        `${levelLabel}只剩「${department.name}」这一个部门，不能删除。` +
          `请先在同一层级新建一个部门，或把其它部门移过来。`,
      );
    }

    await this.prisma.department.delete({ where: { id } });
    await this.auditService.record({
      actorId,
      action: 'DELETE',
      resourceType: 'Department',
      resourceId: id,
      reason: `删除部门「${department.name}」`,
      beforeData: {
        name: department.name,
        code: department.code,
        parentName: department.parent?.name ?? null,
        level: department.parent ? '子级' : '根级',
      },
    });
    return { id, name: department.name };
  }

  async listUsers() {
    const users = await this.prisma.user.findMany({
      where: { deletedAt: null },
      orderBy: [{ displayName: 'asc' }],
      include: {
        roles: { include: { role: { select: { id: true, code: true, name: true } } } },
        departments: { include: { department: { select: { id: true, code: true, name: true } } } },
      },
    });

    return users.map(({ roles, departments, passwordHash: _passwordHash, ...user }) => ({
      ...user,
      roles: roles.map(({ role }) => role),
      departments: departments.map(({ department }) => department),
    }));
  }

  async createUser(input: CreateUserDto, actorId?: string) {
    const passwordHash = await bcrypt.hash(input.password, 12);
    try {
      const user = await this.prisma.user.create({
        data: {
          username: input.username,
          passwordHash,
          displayName: input.displayName,
          email: input.email ?? null,
          phone: input.phone ?? null,
          departments: {
            create: (input.departmentIds ?? []).map((departmentId, index) => ({
              departmentId,
              isPrimary: index === 0,
            })),
          },
          roles: {
            create: (input.roleIds ?? []).map((roleId) => ({ roleId })),
          },
        },
        select: { id: true, username: true, displayName: true },
      });
      await this.auditService.record({ actorId, action: 'CREATE', resourceType: 'User', resourceId: user.id, afterData: user });
      return user;
    } catch (error) {
      this.rethrowConflict(error, '用户名已存在或关联的部门、角色无效');
    }
  }

  async updateUser(id: string, input: UpdateUserDto, actorId?: string) {
    const before = await this.ensureUser(id);
    if (input.status === 'INACTIVE' && before.status !== 'INACTIVE') {
      if (actorId === id) {
        throw new ConflictException('不能停用当前登录账号');
      }
      if (before.isSystemAdmin) {
        const activeSystemAdminCount = await this.prisma.user.count({
          where: { isSystemAdmin: true, status: 'ACTIVE', deletedAt: null },
        });
        if (activeSystemAdminCount <= 1) {
          throw new ConflictException('至少保留一个启用的系统管理员账号');
        }
      }
    }
    const passwordHash = input.password ? await bcrypt.hash(input.password, 12) : undefined;

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id },
        data: {
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(passwordHash ? { passwordHash } : {}),
        },
        select: { id: true, username: true, displayName: true, status: true },
      });

      if (input.departmentIds) {
        await tx.userDepartment.deleteMany({ where: { userId: id } });
        if (input.departmentIds.length) {
          await tx.userDepartment.createMany({
            data: input.departmentIds.map((departmentId, index) => ({
              userId: id,
              departmentId,
              isPrimary: index === 0,
            })),
          });
        }
      }

      if (input.roleIds) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        if (input.roleIds.length) {
          await tx.userRole.createMany({ data: input.roleIds.map((roleId) => ({ userId: id, roleId })) });
        }
      }

      const action = input.status === 'INACTIVE' ? 'DEACTIVATE' : input.status === 'ACTIVE' ? 'ACTIVATE' : 'UPDATE';
      await this.auditService.record({ actorId, action, resourceType: 'User', resourceId: id, beforeData: before, afterData: user });
      return user;
    });
  }

  /**
   * 删除（软删除）用户账号。
   *
   * ## 为什么是软删除
   *
   * 用户被大量业务数据引用（项目负责人、合同负责人、操作记录、审计日志…），
   * 物理删除会破坏这些引用或触发外键约束。因此与业务数据一致：
   * 标记 `deletedAt` + 记录删除原因与操作人，列表默认不显示，管理员可恢复。
   *
   * ## 三道防呆（任何一条不满足都拒绝）
   *
   * 1. 必须填写删除原因
   * 2. **不能删除当前登录账号** —— 否则会把自己踢出系统，无法再登录
   * 3. **不能删除系统管理员** —— 与停用规则一致：系统管理员只能停用，不能删除
   *
   * 三条都只针对"被删的这个账号"本身，**与删除人是谁、系统里有多少个管理员无关**。
   * 删一个普通用户不会影响管理员数量，因此不能拿管理员的规则去拦它。
   *
   * ## 同时做的事
   *
   * - 把状态置为 `INACTIVE`：登录校验除了 `deletedAt` 也看 `status`，双保险
   * - **清空角色与部门关联**：避免"已删除的用户仍占着某个角色"导致角色用户数虚高
   * - **重置密码为随机值**：已删除账号不应还能用原密码登录（即使将来被恢复，
   *   也必须重新设置密码），这比依赖 `deletedAt` 一处判断更稳
   */
  async deleteUser(id: string, reason: string, actorId: string) {
    const trimmed = reason?.trim();
    if (!trimmed) throw new ConflictException('请填写删除原因');

    const before = await this.ensureUser(id);

    if (id === actorId) {
      throw new ConflictException('不能删除当前登录的账号');
    }
    if (before.isSystemAdmin) {
      // 系统管理员一律只能停用，不能删除。
      //
      // 注意：这里必须**先返回**，不能让「至少保留一个管理员」的检查落到非管理员身上
      // —— 曾经的写法把它放在这个分支外面，结果删除任何普通用户（如一个销售）
      // 都会因为"系统里只剩一个管理员"而被拒绝，属于明显的误拦截。
      // 删普通用户不会减少管理员数量，这个检查对它们没有意义。
      throw new ConflictException('系统管理员账号不能删除。如果不再使用，请改为「停用」。');
    }

    // 随机密码：删掉的账号不该还能用原密码登录（恢复后也必须重设密码）
    const scrambled = await bcrypt.hash(randomBytes(24).toString('hex'), 12);

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id },
        data: { deletedAt: new Date(), status: 'INACTIVE', passwordHash: scrambled },
        select: { id: true, username: true, displayName: true, status: true, deletedAt: true },
      });
      // 解除角色与部门关联，避免已删除账号仍占着角色
      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.userDepartment.deleteMany({ where: { userId: id } });

      await this.auditService.record({
        actorId,
        action: 'DELETE',
        resourceType: 'User',
        resourceId: id,
        reason: trimmed,
        beforeData: { username: before.username, displayName: before.displayName, status: before.status, isSystemAdmin: before.isSystemAdmin },
        afterData: { deletedAt: user.deletedAt, status: user.status },
      });
      return user;
    });
  }

  /**
   * 恢复被删除的用户账号。
   *
   * 注意：**不恢复角色与部门**（删除时已解除）。恢复后账号处于启用状态但没有角色，
   * 需要管理员重新分配 —— 这是刻意的：人员离职再入职，职责通常已经变了，
   * 直接沿用旧角色反而有越权风险。
   *
   * 密码也不会恢复（删除时已重置为随机值），需管理员重设密码后交还本人。
   */
  async restoreUser(id: string, actorId: string, reason?: string) {
    const user = await this.prisma.user.findFirst({ where: { id, deletedAt: { not: null } } });
    if (!user) throw new NotFoundException('该账号不在已删除状态，无需恢复');

    const restored = await this.prisma.user.update({
      where: { id },
      data: { deletedAt: null, status: 'ACTIVE' },
      select: { id: true, username: true, displayName: true, status: true },
    });
    await this.auditService.record({
      actorId,
      action: 'RESTORE',
      resourceType: 'User',
      resourceId: id,
      reason: reason?.trim() || '管理员恢复已删除的用户账号',
      afterData: { deletedAt: null, status: 'ACTIVE', note: '未恢复角色与部门，需重新分配' },
    });
    return restored;
  }

  async listRoles() {
    return this.prisma.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: {
        _count: { select: { users: true, permissions: true } },
        permissions: { select: { permissionId: true, allowed: true, dataScope: true } },
      },
    });
  }

  async createRole(input: CreateRoleDto, actorId?: string) {
    try {
      const role = await this.prisma.role.create({ data: { name: input.name, code: generateInternalCode('ROLE'), description: input.description ?? null } });
      await this.auditService.record({ actorId, action: 'CREATE', resourceType: 'Role', resourceId: role.id, afterData: role });
      return role;
    } catch (error) {
      this.rethrowConflict(error, '角色创建失败，请检查角色信息后重试');
    }
  }

  async updateRole(id: string, input: UpdateRoleDto, actorId?: string) {
    const before = await this.prisma.role.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('角色不存在');
    const role = await this.prisma.role.update({ where: { id }, data: input });
    await this.auditService.record({ actorId, action: 'UPDATE', resourceType: 'Role', resourceId: id, beforeData: before, afterData: role });
    return role;
  }

  async listPermissions() {
    return this.prisma.permission.findMany({
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
    });
  }

  async listAuditLogs() {
    return this.auditService.list();
  }

  async listFieldDefinitions(moduleKey?: string) {
    return this.prisma.fieldDefinition.findMany({
      ...(moduleKey ? { where: { moduleKey } } : {}),
      orderBy: [{ moduleKey: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createFieldDefinition(input: CreateFieldDefinitionDto, actorId?: string) {
    try {
      const field = await this.prisma.fieldDefinition.create({
        data: {
          moduleKey: input.moduleKey,
          fieldKey: generateInternalCode('FIELD', true),
          label: input.label,
          fieldType: input.fieldType,
          isRequired: input.isRequired ?? false,
          isListVisible: input.isListVisible ?? false,
          isSearchable: input.isSearchable ?? false,
          sortOrder: input.sortOrder ?? (await this.nextFieldSortOrder(input.moduleKey)),
          ...(input.config ? { config: input.config as Prisma.InputJsonValue } : {}),
        },
      });
      await this.auditService.record({ actorId, action: 'CREATE', resourceType: 'FieldDefinition', resourceId: field.id, afterData: field });
      return field;
    } catch (error) {
      this.rethrowConflict(error, '字段创建失败，请检查字段信息后重试');
    }
  }

  /**
   * 新增字段时的默认排序号：接在该模块现有最大值之后。
   *
   * 原实现默认写 0，会让新建字段直接跳到列表**最前面** —— 与"新加的东西排在最后"
   * 的直觉相反，管理员每次都得手工把这个数字改掉。
   *
   * 注意排序号现在是 1、2、3…的连续值（见 prisma/seed.ts 的 normalizeSortOrders），
   * 不再使用 10、20、30 的步长，所以这里直接 +1 即可。
   */
  private async nextFieldSortOrder(moduleKey: string): Promise<number> {
    const aggregated = await this.prisma.fieldDefinition.aggregate({
      where: { moduleKey },
      _max: { sortOrder: true },
    });
    return (aggregated._max.sortOrder ?? 0) + 1;
  }

  async updateFieldDefinition(id: string, input: UpdateFieldDefinitionDto, actorId?: string) {
    const before = await this.prisma.fieldDefinition.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('字段定义不存在');
    if (before.isSystem && input.isActive === false) throw new ConflictException('系统关键字段不可删除');
    const field = await this.prisma.fieldDefinition.update({
      where: { id },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.fieldType !== undefined ? { fieldType: input.fieldType } : {}),
        ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
        ...(input.isListVisible !== undefined ? { isListVisible: input.isListVisible } : {}),
        ...(input.isSearchable !== undefined ? { isSearchable: input.isSearchable } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.config !== undefined ? { config: input.config as Prisma.InputJsonValue } : {}),
      },
    });
    await this.auditService.record({ actorId, action: 'UPDATE', resourceType: 'FieldDefinition', resourceId: id, beforeData: before, afterData: field });
    return field;
  }

  async deleteFieldDefinition(id: string, actorId?: string) {
    const before = await this.prisma.fieldDefinition.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('字段定义不存在');
    if (before.isSystem) throw new ConflictException('系统关键字段不可删除，只能调整显示和权限');
    const field = await this.prisma.fieldDefinition.update({ where: { id }, data: { isActive: false } });
    await this.auditService.record({ actorId, action: 'DISABLE', resourceType: 'FieldDefinition', resourceId: id, beforeData: before, afterData: field });
    return field;
  }

  async updateRolePermissions(roleId: string, input: UpdateRolePermissionsDto, actorId?: string) {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException('角色不存在');

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      if (input.assignments.length) {
        await tx.rolePermission.createMany({
          data: input.assignments.map((assignment) => ({
            roleId,
            permissionId: assignment.permissionId,
            allowed: assignment.allowed,
            dataScope: assignment.dataScope,
          })),
        });
      }
      return tx.role.findUnique({
        where: { id: roleId },
        include: { permissions: { include: { permission: true } } },
      });
    });
    await this.auditService.record({ actorId, action: 'REPLACE_PERMISSIONS', resourceType: 'Role', resourceId: roleId, afterData: input });
    return result;
  }

  private async ensureDepartment(id: string) {
    const department = await this.prisma.department.findUnique({ where: { id } });
    if (!department) throw new NotFoundException('部门不存在');
    return department;
  }

  private async ensureUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        phone: true,
        status: true,
        isSystemAdmin: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
      },
    });
    if (!user) throw new NotFoundException('用户不存在');
    return user;
  }

  private rethrowConflict(error: unknown, message: string): never {
    if (typeof error === 'object' && error && 'code' in error) {
      throw new ConflictException(message);
    }
    throw error;
  }
}
