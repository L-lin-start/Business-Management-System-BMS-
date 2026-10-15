import { Body, Controller, Get, HttpCode, HttpStatus, Inject, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, AuthenticatedRequest } from '../../modules/auth/access-token.guard';
import { PermissionGuard } from '../../modules/auth/permission.guard';
import { RequirePermission } from '../../modules/auth/permission.decorator';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ContractService } from '../../modules/contracts/contract.service';
import { ProjectService } from '../../modules/projects/project.service';
import { CustomerService } from '../../modules/customers/customer.service';
import { PaymentService } from '../../modules/payments/payment.service';
import { CostService } from '../../modules/costs/cost.service';
import { AdminService } from '../../modules/admin/admin.service';
import { RestoreReasonDto } from './delete-reason.dto';

/** 可恢复的资源类型 → 中文名。恢复只支持这些（与 PRD 7.1「管理员可恢复删除数据」对应）。 */
const RESTORABLE: Record<string, string> = {
  Contract: '合同',
  Project: '项目',
  Customer: '客户',
  PaymentReceipt: '回款',
  CostRecord: '成本',
  OfficialDocument: '官文',
  ActionRecord: '动作记录',
  FilingResult: '申报结果',
  MailDelivery: '邮件送达',
  User: '用户账号',
};

type DeletedRow = {
  resourceType: string;
  resourceLabel: string;
  id: string;
  /** 人类可读的标识（合同编号 / 项目编号 / 客户名…） */
  display: string;
  deletedAt: Date | null;
  deleteReason: string | null;
  deletedBy: string | null;
  /** 是否因父级级联而作废（级联原因的文案里带「所属…已删除」） */
  cascaded: boolean;
};

/**
 * 已删除数据（PRD 7.1 / 7.2）。
 *
 * > 管理员可查看已删除数据并恢复。
 *
 * 这里只暴露**查询**与**恢复**两个动作：
 *   - 查询：把各表 `deletedAt != null` 的记录统一成一个列表，按删除时间倒序
 *   - 恢复：按资源类型分发到对应 Service 的 `restore()`，各自负责自己的级联回滚
 *
 * 权限统一用 `system.admin.access`（PRD 明确写"仅管理员"）。
 */
@Controller('api/admin/deleted-records')
@UseGuards(AccessTokenGuard, PermissionGuard)
export class DeletedRecordsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(ContractService) private readonly contractService: ContractService,
    @Inject(ProjectService) private readonly projectService: ProjectService,
    @Inject(CustomerService) private readonly customerService: CustomerService,
    @Inject(PaymentService) private readonly paymentService: PaymentService,
    @Inject(CostService) private readonly costService: CostService,
    @Inject(AdminService) private readonly adminService: AdminService,
  ) {}

  @Get()
  @RequirePermission('system.admin.access')
  async list(@Query() query: { resourceType?: string; keyword?: string; page?: string; pageSize?: string }) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 50));
    const types = query.resourceType && RESTORABLE[query.resourceType] ? [query.resourceType] : Object.keys(RESTORABLE);
    const rows: DeletedRow[] = [];

    // 逐表取已删除记录。数据量不大（软删除不会长期堆积，管理员会恢复或定期清理），
    // 因此这里直接查全量再在内存里合并排序，避免写复杂的 UNION。
    if (types.includes('Contract')) {
      const items = await this.prisma.contract.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, contractNo: true, deletedAt: true, deleteReason: true, deletedBy: true },
      });
      rows.push(...items.map((item) => this.toRow('Contract', item.id, item.contractNo, item.deletedAt, item.deleteReason, item.deletedBy)));
    }
    if (types.includes('Project')) {
      const items = await this.prisma.project.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, projectNo: true, projectName: true, deletedAt: true, deleteReason: true, deletedBy: true },
      });
      rows.push(
        ...items.map((item) => this.toRow('Project', item.id, `${item.projectNo} ${item.projectName}`, item.deletedAt, item.deleteReason, item.deletedBy)),
      );
    }
    if (types.includes('Customer')) {
      const items = await this.prisma.customer.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, name: true, deletedAt: true, deleteReason: true, deletedBy: true },
      });
      rows.push(...items.map((item) => this.toRow('Customer', item.id, item.name, item.deletedAt, item.deleteReason, item.deletedBy)));
    }
    if (types.includes('PaymentReceipt')) {
      const items = await this.prisma.paymentReceipt.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, receiptNo: true, amount: true, deletedAt: true, deleteReason: true, deletedBy: true },
      });
      rows.push(...items.map((item) => this.toRow('PaymentReceipt', item.id, `${item.receiptNo} ¥${item.amount}`, item.deletedAt, item.deleteReason, item.deletedBy)));
    }
    if (types.includes('CostRecord')) {
      const items = await this.prisma.costRecord.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, costType: true, amount: true, deletedAt: true, deleteReason: true, deletedBy: true },
      });
      rows.push(...items.map((item) => this.toRow('CostRecord', item.id, `${item.costType} ¥${item.amount}`, item.deletedAt, item.deleteReason, item.deletedBy)));
    }
    if (types.includes('OfficialDocument')) {
      const items = await this.prisma.officialDocument.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, documentName: true, deletedAt: true, deleteReason: true, deletedBy: true },
      });
      rows.push(...items.map((item) => this.toRow('OfficialDocument', item.id, item.documentName, item.deletedAt, item.deleteReason, item.deletedBy)));
    }
    if (types.includes('ActionRecord')) {
      const items = await this.prisma.actionRecord.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, actionType: true, deletedAt: true, deleteReason: true, deletedBy: true },
      });
      rows.push(...items.map((item) => this.toRow('ActionRecord', item.id, item.actionType ?? '动作记录', item.deletedAt, item.deleteReason, item.deletedBy)));
    }
    if (types.includes('FilingResult')) {
      const items = await this.prisma.filingResult.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, resultCode: true, deletedAt: true, deleteReason: true, deletedBy: true },
      });
      rows.push(...items.map((item) => this.toRow('FilingResult', item.id, item.resultCode ?? '申报结果', item.deletedAt, item.deleteReason, item.deletedBy)));
    }
    if (types.includes('MailDelivery')) {
      const items = await this.prisma.mailDelivery.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, recipientEmail: true, deletedAt: true, deleteReason: true, deletedBy: true },
      });
      rows.push(...items.map((item) => this.toRow('MailDelivery', item.id, item.recipientEmail, item.deletedAt, item.deleteReason, item.deletedBy)));
    }

    // 用户账号：User 表**没有** deleteReason / deletedBy 字段（合同/项目/客户才有），
    // 所以原因与操作人只能从审计日志取 —— 删除用户时 AdminService 一定会写一条
    // resourceType='User'、action='DELETE' 的日志。这里按 resourceId 关联回来，
    // 否则列表上这一行会是"无原因、无操作人"，管理员不敢恢复。
    if (types.includes('User')) {
      const items = await this.prisma.user.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true, username: true, displayName: true, deletedAt: true },
      });
      const userIds = items.map((item) => item.id);
      const logs = userIds.length
        ? await this.prisma.auditLog.findMany({
            where: { resourceType: 'User', resourceId: { in: userIds }, action: 'DELETE' },
            orderBy: { createdAt: 'desc' },
            select: { resourceId: true, reason: true, actorId: true },
          })
        : [];
      // 同一账号可能被删多次（删除→恢复→再删除），取最近一次
      const latest = new Map<string, { reason: string | null; actorId: string | null }>();
      for (const log of logs) {
        if (log.resourceId && !latest.has(log.resourceId)) {
          latest.set(log.resourceId, { reason: log.reason, actorId: log.actorId });
        }
      }
      rows.push(
        ...items.map((item) => {
          const info = latest.get(item.id);
          return this.toRow(
            'User',
            item.id,
            `${item.displayName}（${item.username}）`,
            item.deletedAt,
            info?.reason ?? null,
            info?.actorId ?? null,
          );
        }),
      );
    }

    // 操作人姓名（避免界面上只显示一串 cuid）
    const userIds = [...new Set(rows.map((row) => row.deletedBy).filter((value): value is string => Boolean(value)))];
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })
      : [];
    const nameById = new Map(users.map((user) => [user.id, user.displayName]));

    let filtered = rows;
    if (query.keyword?.trim()) {
      const keyword = query.keyword.trim().toLowerCase();
      filtered = filtered.filter((row) => row.display.toLowerCase().includes(keyword) || row.resourceLabel.includes(keyword));
    }
    filtered.sort((left, right) => (right.deletedAt?.getTime() ?? 0) - (left.deletedAt?.getTime() ?? 0));

    const total = filtered.length;
    const items = filtered.slice((page - 1) * pageSize, page * pageSize).map((row) => ({
      ...row,
      deletedByName: row.deletedBy ? (nameById.get(row.deletedBy) ?? row.deletedBy) : null,
    }));
    return { items, total, page, pageSize, resourceTypes: RESTORABLE };
  }

  @Post(':resourceType/:id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('system.admin.access')
  async restore(
    @Param('resourceType') resourceType: string,
    @Param('id') id: string,
    @Body() body: RestoreReasonDto,
    @Req() request: AuthenticatedRequest,
  ) {
    const label = RESTORABLE[resourceType];
    if (!label) throw new NotFoundException(`不支持恢复的类型「${resourceType}」`);

    // 必须用真实 userId：AuditLog.actorId 对 User 有外键约束，
    // 传占位字符串（如 'system-admin'）会触发 P2003 外键冲突导致 500。
    const actorId = request.auth.userId;

    // 恢复必须走各 Service 自己的 restore：合同/项目要**回滚级联**
    // （按 deleteReason 判断哪些子记录是因本次删除而作废的）。
    // 直接 update 会把子记录留在作废状态，产生"父级活了、子级还是死的"这种不一致。
    switch (resourceType) {
      case 'Contract':
        return this.contractService.restore(id, actorId, body.reason);
      case 'Project':
        return this.projectService.restore(id, actorId, body.reason);
      case 'Customer':
        return this.customerService.restore(id, actorId, body.reason);
      case 'PaymentReceipt':
        return this.paymentService.restore(id, actorId, body.reason);
      case 'CostRecord':
        return this.costService.restore(id, actorId, body.reason);
      case 'User':
        // 用户恢复走 AdminService.restoreUser：它不还原角色与部门（职责可能已变），
        // 也不还原密码（删除时已重置为随机值），恢复后需管理员重新分配与重设密码。
        return this.adminService.restoreUser(id, actorId, body.reason);
      default:
        // 四类附属记录没有级联子级，直接就地恢复即可
        return this.restoreLeaf(resourceType, id, label, actorId, body.reason);
    }
  }

  /** 附属记录（官文/动作/申报/邮件）的恢复：无级联子级，就地恢复 + 留痕 */
  private async restoreLeaf(resourceType: string, id: string, label: string, actorId: string, reason?: string) {
    const map: Record<string, () => Promise<unknown>> = {
      OfficialDocument: async () => this.prisma.officialDocument.update({ where: { id }, data: { deletedAt: null, deleteReason: null, deletedBy: null } }),
      ActionRecord: async () => this.prisma.actionRecord.update({ where: { id }, data: { deletedAt: null, deleteReason: null, deletedBy: null } }),
      FilingResult: async () => this.prisma.filingResult.update({ where: { id }, data: { deletedAt: null, deleteReason: null, deletedBy: null } }),
      MailDelivery: async () => this.prisma.mailDelivery.update({ where: { id }, data: { deletedAt: null, deleteReason: null, deletedBy: null } }),
    };
    const action = map[resourceType];
    if (!action) throw new NotFoundException(`不支持恢复的类型「${resourceType}」`);
    await action();
    await this.auditService.record({
      actorId,
      action: 'RESTORE',
      resourceType,
      resourceId: id,
      reason: reason?.trim() || `管理员恢复已删除的${label}`,
      afterData: { deletedAt: null },
    });
    return { id, resourceType, restored: true };
  }

  private toRow(
    resourceType: string,
    id: string,
    display: string | null,
    deletedAt: Date | null,
    deleteReason: string | null,
    deletedBy: string | null,
  ): DeletedRow {
    return {
      resourceType,
      resourceLabel: RESTORABLE[resourceType] ?? resourceType,
      id,
      display: display ?? '(无名称)',
      deletedAt,
      deleteReason,
      deletedBy,
      // 级联作废的原因统一写成「所属…已删除」，据此在界面上标出来，
      // 让管理员知道"这条不是人主动删的，是跟着父级走的"
      cascaded: Boolean(deleteReason?.includes('已删除')),
    };
  }
}
