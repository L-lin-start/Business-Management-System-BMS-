import { Inject, Injectable } from '@nestjs/common';
import { DataScope, Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { ReminderService } from '../reminders/reminder.service';

@Injectable()
export class DashboardService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ReminderService) private readonly reminderService: ReminderService,
  ) {}

  async overview(userId: string, dataScope: DataScope) {
    if (dataScope === 'NONE') return this.emptyOverview();
    const ownerIds = await this.accessibleOwnerIds(userId, dataScope);
    const customerWhere: Prisma.CustomerWhereInput = { deletedAt: null, ...(ownerIds ? { ownerId: { in: ownerIds } } : {}) };
    const contractWhere: Prisma.ContractWhereInput = {
      deletedAt: null,
      ...(ownerIds ? { OR: [{ ownerId: { in: ownerIds } }, { customer: { ownerId: { in: ownerIds } } }] } : {}),
    };
    const projectWhere: Prisma.ProjectWhereInput = {
      deletedAt: null,
      ...(ownerIds ? { OR: [{ ownerId: { in: ownerIds } }, { contract: { ownerId: { in: ownerIds } } }, { contract: { customer: { ownerId: { in: ownerIds } } } }] } : {}),
    };
    const [customerCount, contractStats, projectCount, paymentStats, costStats] = await this.prisma.$transaction([
      this.prisma.customer.count({ where: customerWhere }),
      this.prisma.contract.aggregate({ where: contractWhere, _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.project.count({ where: projectWhere }),
      // 已收款按合同分配金额汇总；一笔回款跨合同或跨项目时不会重复计算
      this.prisma.paymentContractAllocation.aggregate({ where: { payment: { deletedAt: null }, contract: contractWhere }, _sum: { amount: true } }),
      // 成本登记在项目上，按项目的数据范围汇总
      this.prisma.costRecord.aggregate({ where: { deletedAt: null, project: projectWhere }, _sum: { amount: true } }),
    ]);
    const collected = paymentStats._sum.amount ?? new Prisma.Decimal(0);
    const costs = costStats._sum.amount ?? new Prisma.Decimal(0);

    // 提醒汇总：待办提醒直接进首页，避免用户必须点进提醒页才知道有事要办
    const [unhandledReminders, overdueReminders] = await this.prisma.$transaction([
      this.prisma.reminder.count({ where: { isHandled: false } }),
      this.prisma.reminder.count({ where: { isHandled: false, overdueDays: { gt: 0 } } }),
    ]);
    // 状态分布单独查询：放进 $transaction 元组会让聚合字段被推断成可选，取值时还要额外断言
    const contractStatusGroups = await this.prisma.contract.groupBy({
      by: ['statusCode'],
      where: contractWhere,
      orderBy: { statusCode: 'asc' },
      _count: { _all: true },
      _sum: { amount: true },
    });
    const projectStatusGroups = await this.prisma.project.groupBy({
      by: ['statusCode'],
      where: projectWhere,
      orderBy: { statusCode: 'asc' },
      _count: { _all: true },
    });

    return {
      customerCount,
      contractCount: contractStats._count._all,
      contractAmount: (contractStats._sum.amount ?? new Prisma.Decimal(0)).toFixed(2),
      projectCount,
      collectedAmount: collected.toFixed(2),
      costAmount: costs.toFixed(2),
      netProfit: collected.minus(costs).toFixed(2),
      unpaidAmount: (contractStats._sum.amount ?? new Prisma.Decimal(0)).minus(collected).toFixed(2),
      reminders: { unhandled: unhandledReminders, overdue: overdueReminders },
      // PRD 第十章「卡片四：待办提醒」的四项口径。
      // 按当前人的数据范围收窄：否则销售在首页会看到全局业务量（与管理员的数字一模一样）。
      prdReminders: await this.reminderService.prdSummary({ userId, dataScope }),
      contractStatusDistribution: contractStatusGroups.map((item) => ({
        statusCode: item.statusCode,
        count: item._count._all,
        amount: (item._sum.amount ?? new Prisma.Decimal(0)).toFixed(2),
      })),
      projectStatusDistribution: projectStatusGroups.map((item) => ({ statusCode: item.statusCode, count: item._count._all })),
    };
  }

  private async accessibleOwnerIds(userId: string, dataScope: DataScope): Promise<string[] | null> {
    if (dataScope === 'ALL') return null;
    if (dataScope === 'SELF' || dataScope === 'RELATED') return [userId];
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
    return [...new Set(members.map((item) => item.userId))];
  }

  private emptyOverview() {
    return {
      customerCount: 0,
      contractCount: 0,
      contractAmount: '0.00',
      projectCount: 0,
      collectedAmount: '0.00',
      costAmount: '0.00',
      netProfit: '0.00',
      unpaidAmount: '0.00',
      reminders: { unhandled: 0, overdue: 0 },
      prdReminders: {
        todayTodo: 0,
        overdueProjects: 0,
        overdueMailRegistrations: 0,
        paymentPendingContracts: 0,
        unhandled: 0,
        overdue: 0,
        unavailable: [],
      },
      contractStatusDistribution: [],
      projectStatusDistribution: [],
    };
  }
}
