import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataScope, Prisma } from '@prisma/client';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { CustomFieldsService } from '../../infrastructure/custom-fields/custom-fields.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { CreateCustomerDto, CustomerQueryDto, UpdateCustomerDto } from './dto/customer.dto';

@Injectable()
export class CustomerService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(CustomFieldsService) private readonly customFields: CustomFieldsService,
  ) {}

  async list(query: CustomerQueryDto, userId: string, dataScope: DataScope) {
    const currentPage = Math.max(1, Number(query.page) || 1);
    const currentPageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const scopeWhere = await this.buildScopeWhere(userId, dataScope);
    const where: Prisma.CustomerWhereInput = {
      // 范围过滤与业务筛选用 AND 组合：`buildScopeWhere` 在 RELATED 范围下返回 `OR`，
      // 与 keyword 的 `OR` 用对象展开会互相覆盖，导致数据范围失效。
      AND: [
        scopeWhere,
        {
          ...(query.includeDeleted ? {} : { deletedAt: null }),
          ...(query.customerType ? { customerType: query.customerType } : {}),
          ...(query.ownerId ? { ownerId: query.ownerId } : {}),
          ...(query.keyword
            ? {
                OR: [
                  { name: { contains: query.keyword, mode: 'insensitive' } },
                  { contactName: { contains: query.keyword, mode: 'insensitive' } },
                  { phone: { contains: query.keyword, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
      ],
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }],
        skip: (currentPage - 1) * currentPageSize,
        take: currentPageSize,
        include: {
          owner: { select: { id: true, username: true, displayName: true } },
          _count: { select: { contracts: true } },
        },
      }),
      this.prisma.customer.count({ where }),
    ]);

    return { items, total, page: currentPage, pageSize: currentPageSize };
  }

  async getById(id: string, userId: string, dataScope: DataScope) {
    const scopeWhere = await this.buildScopeWhere(userId, dataScope);
    const customer = await this.prisma.customer.findFirst({
      where: { id, deletedAt: null, ...scopeWhere },
      include: {
        owner: { select: { id: true, username: true, displayName: true } },
        _count: { select: { contracts: true } },
      },
    });
    if (!customer) throw new NotFoundException('客户不存在或无权查看');
    return customer;
  }

  listOwners() {
    return this.prisma.user.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      orderBy: { displayName: 'asc' },
      select: { id: true, username: true, displayName: true },
    });
  }

  /**
   * 判断当前用户新建客户时能否自由指定「所属销售」。
   *
   * 规则（业务确认 2026-10-14）：
   *   - 数据范围为 ALL 的角色（总经理、系统管理员）可以自由指派 —— 分配客户本来就是他们的动作；
   *   - 其余角色（销售等）**强制绑定自己**，且**忽略**请求里传来的 ownerId。
   *
   * 为什么要忽略而不是报错：这是权限收窄，不是非法请求。
   * 前端可能因为缓存或旧版本仍带着 ownerId，静默改写比抛错体验好，
   * 但**必须改写**，否则销售 A 可以把客户建到销售 B 名下（越权）。
   */
  private async canAssignOwner(actorId: string): Promise<boolean> {
    const actor = await this.prisma.user.findUnique({
      where: { id: actorId },
      select: { isSystemAdmin: true },
    });
    if (actor?.isSystemAdmin) return true;

    const permissions = await this.prisma.rolePermission.findMany({
      where: { role: { users: { some: { userId: actorId } } }, permission: { code: 'customer.manage' }, allowed: true },
      select: { dataScope: true },
    });
    // 只要有一个角色给了 ALL 范围，就视为可指派（与权限守卫"取最宽范围"的口径一致）
    return permissions.some((item) => item.dataScope === 'ALL');
  }

  /**
   * 解析新建客户时的「所属销售」。
   * 可指派 → 用请求值（未传则默认自己）；不可指派 → 强制自己，忽略请求值。
   */
  async resolveCreateOwnerId(inputOwnerId: string | undefined, actorId: string): Promise<string> {
    if (!(await this.canAssignOwner(actorId))) return actorId;
    return inputOwnerId ?? actorId;
  }

  /**
   * 表单字段锁定规则，供前端渲染。
   *
   * 当前只有一条：`ownerId`（所属销售）。
   * 不可指派的角色（销售等）新建客户时该字段锁死为自己，不能选别人；
   * 可指派的角色（总经理、系统管理员）保持下拉可选。
   */
  async formPolicy(actorId: string) {
    const canAssignOwner = await this.canAssignOwner(actorId);
    const actor = await this.prisma.user.findUnique({
      where: { id: actorId },
      select: { id: true, username: true, displayName: true },
    });
    return {
      ownerId: {
        /** 是否锁定：true = 前端应显示为只读，且不提交该字段 */
        locked: !canAssignOwner,
        /** 锁定时的固定值 */
        lockedValue: canAssignOwner ? null : actorId,
        /** 锁定值的可读名称，前端直接展示 */
        lockedLabel: canAssignOwner ? null : (actor?.displayName ?? actor?.username ?? null),
        /** 为什么锁定，前端作为提示文案 */
        reason: canAssignOwner
          ? '你的角色可以指派所属销售'
          : '你的角色只能把客户归属于自己，系统已自动绑定，无需选择',
      },
    };
  }

  async create(input: CreateCustomerDto, actorId: string) {
    // 自定义字段按系统 B 的字段定义校验（必填、类型、选项、默认值）
    const customFields = await this.customFields.sanitize('customer', input.customFields);
    const ownerId = await this.resolveCreateOwnerId(input.ownerId, actorId);
    const customer = await this.prisma.customer.create({
      data: {
        name: input.name.trim(),
        customerType: input.customerType ?? null,
        contactName: input.contactName ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        ownerId,
        ...(customFields ? { customFields } : {}),
      },
      include: { owner: { select: { id: true, username: true, displayName: true } } },
    });
    // 被强制改写时留痕，便于排查"为什么建到别人名下/为什么改不了"
    const ownerOverridden = input.ownerId !== undefined && input.ownerId !== ownerId;
    await this.auditService.record({
      actorId,
      action: 'CREATE',
      resourceType: 'Customer',
      resourceId: customer.id,
      ...(ownerOverridden
        ? { reason: `所属销售已强制绑定为当前登录人（请求值 ${input.ownerId} 被忽略）` }
        : {}),
      afterData: customer,
    });
    return customer;
  }

  async update(id: string, input: UpdateCustomerDto, actorId: string, dataScope: DataScope) {
    const before = await this.getEditableCustomer(id, actorId, dataScope);
    const customFields = input.customFields === undefined
      ? undefined
      : await this.customFields.sanitize('customer', input.customFields);

    // 「所属销售」的收窄规则在编辑时同样生效，否则销售建完客户再把自己改成别人就等于绕过了限制。
    // 不可指派者：只能把 owner 保持为自己（显式传别人 → 拒绝，避免静默改写让人以为改成功了）。
    const canAssign = await this.canAssignOwner(actorId);
    if (!canAssign && input.ownerId !== undefined && input.ownerId !== actorId) {
      throw new ForbiddenException('你的角色不能把客户分配给他人，所属销售只能是你自己');
    }

    const customer = await this.prisma.customer.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.customerType !== undefined ? { customerType: input.customerType || null } : {}),
        ...(input.contactName !== undefined ? { contactName: input.contactName || null } : {}),
        ...(input.phone !== undefined ? { phone: input.phone || null } : {}),
        ...(input.email !== undefined ? { email: input.email || null } : {}),
        ...(input.address !== undefined ? { address: input.address || null } : {}),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId || null } : {}),
        ...(customFields !== undefined ? { customFields } : {}),
      },
      include: { owner: { select: { id: true, username: true, displayName: true } } },
    });
    await this.auditService.record({ actorId, action: 'UPDATE', resourceType: 'Customer', resourceId: id, beforeData: before, afterData: customer });
    return customer;
  }

  /**
   * 软删除客户（PRD 7.2）。
   *
   * 必须填删除原因并落库。**有合同的客户不允许直接删除** ——
   * 否则会留下"合同挂在不存在的客户上"的脏数据（合同还在跑、客户没了）。
   * 要停用客户请先处理其合同（走终止），或直接保留客户不删。
   */
  async softDelete(id: string, actorId: string, dataScope: DataScope, reason?: string) {
    const trimmed = reason?.trim();
    if (!trimmed) throw new BadRequestException('请填写删除原因');

    const before = await this.getEditableCustomer(id, actorId, dataScope);

    const contractCount = await this.prisma.contract.count({ where: { customerId: id, deletedAt: null } });
    if (contractCount > 0) {
      throw new ConflictException(
        `该客户名下还有 ${contractCount} 张未删除的合同，不能直接删除。请先终止或删除这些合同，避免合同挂在不存在的客户上。`,
      );
    }

    const customer = await this.prisma.customer.update({
      where: { id },
      data: { deletedAt: new Date(), deleteReason: trimmed, deletedBy: actorId },
    });
    await this.auditService.record({
      actorId,
      action: 'SOFT_DELETE',
      resourceType: 'Customer',
      resourceId: id,
      reason: trimmed,
      beforeData: before,
      afterData: { deletedAt: customer.deletedAt, deleteReason: customer.deleteReason },
    });
    return { id, deletedAt: customer.deletedAt };
  }

  /** 恢复被软删除的客户（PRD 7.1，仅管理员） */
  async restore(id: string, actorId: string, reason?: string) {
    const customer = await this.prisma.customer.findFirst({ where: { id, deletedAt: { not: null } } });
    if (!customer) throw new NotFoundException('该客户不在已删除状态，无需恢复');
    await this.prisma.customer.update({ where: { id }, data: { deletedAt: null, deleteReason: null, deletedBy: null } });
    await this.auditService.record({
      actorId,
      action: 'RESTORE',
      resourceType: 'Customer',
      resourceId: id,
      reason: reason?.trim() || '管理员恢复已删除的客户',
      beforeData: { deletedAt: customer.deletedAt, deleteReason: customer.deleteReason },
      afterData: { deletedAt: null },
    });
    return { id, restored: true };
  }

  private async getEditableCustomer(id: string, userId: string, dataScope: DataScope) {
    const scopeWhere = await this.buildScopeWhere(userId, dataScope);
    const customer = await this.prisma.customer.findFirst({ where: { id, deletedAt: null, ...scopeWhere } });
    if (!customer) throw new NotFoundException('客户不存在或无权操作');
    return customer;
  }

  /**
   * 导出的过滤条件（PRD 4.12）。
   *
   * 直接复用列表用的 `buildScopeWhere`，**口径完全一致** ——
   * 避免导出另写一套范围判定，出现「列表看不到、导出却能看到」这类越权。
   */
  async buildExportWhere(query: CustomerQueryDto, userId: string, dataScope: DataScope): Promise<Prisma.CustomerWhereInput> {
    return {
      // 与 list() 一致的 AND 组合，避免 `OR` 覆盖导致导出越权
      AND: [
        await this.buildScopeWhere(userId, dataScope),
        {
          deletedAt: null,
          ...(query.customerType ? { customerType: query.customerType } : {}),
          ...(query.ownerId ? { ownerId: query.ownerId } : {}),
          ...(query.keyword
            ? {
                OR: [
                  { name: { contains: query.keyword, mode: 'insensitive' } },
                  { contactName: { contains: query.keyword, mode: 'insensitive' } },
                  { phone: { contains: query.keyword, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
      ],
    };
  }

  private async buildScopeWhere(userId: string, dataScope: DataScope): Promise<Prisma.CustomerWhereInput> {
    if (dataScope === 'ALL') return {};
    if (dataScope === 'SELF') return { ownerId: userId };
    if (dataScope === 'RELATED') {
      return { OR: [{ ownerId: userId }, { contracts: { some: { OR: [{ ownerId: userId }, { projects: { some: { ownerId: userId } } }] } } }] };
    }
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

    const members = await this.prisma.userDepartment.findMany({
      where: { departmentId: { in: [...departmentIds] } },
      select: { userId: true },
    });
    return { ownerId: { in: [...new Set(members.map((item) => item.userId))] } };
  }
}

