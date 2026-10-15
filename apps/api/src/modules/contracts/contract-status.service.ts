import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { HistoryService } from '../history/history.service';

/**
 * 合同状态自动同步规则：
 * - 项目第一次发生节点流转（或项目已进入进行/完成状态）后，合同至少为“执行中”；
 * - 全部未删除项目完成，且已收款 + 合同调整额 >= 合同金额时，合同为“已完成”；
 * - 合同已终止时不再被自动状态同步覆盖。
 *
 * 所有入口统一调用本服务，避免节点推进、回款、金额调整各自维护一套口径。
 */
@Injectable()
export class ContractStatusService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(HistoryService) private readonly historyService: HistoryService,
  ) {}

  async reconcile(contractId: string, actorId: string, reason: string) {
    const [contract, projects, allocationRows, legacyRows, adjustments, nodeHistoryCount] = await Promise.all([
      this.prisma.contract.findUnique({ where: { id: contractId }, select: { id: true, statusCode: true, amount: true, version: true } }),
      this.prisma.project.findMany({ where: { contractId, deletedAt: null }, select: { statusCode: true } }),
      this.prisma.paymentContractAllocation.findMany({ where: { contractId, payment: { deletedAt: null } }, select: { amount: true } }),
      this.prisma.paymentReceipt.findMany({ where: { contractId, deletedAt: null, contractAllocations: { none: {} } }, select: { amount: true } }),
      this.prisma.contractAmountAdjustment.findMany({ where: { contractId, deletedAt: null }, select: { amount: true } }),
      this.prisma.projectNodeHistory.count({ where: { project: { contractId, deletedAt: null } } }),
    ]);

    if (!contract || contract.statusCode === 'TERMINATED') return null;

    const collected = [...allocationRows, ...legacyRows].reduce(
      (sum, item) => sum.plus(item.amount),
      new Prisma.Decimal(0),
    );
    const adjusted = adjustments.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
    const allProjectsCompleted = projects.length > 0 && projects.every((project) => project.statusCode === 'COMPLETED');
    const paymentCompleted = collected.plus(adjusted).greaterThanOrEqualTo(contract.amount);
    const projectStarted = nodeHistoryCount > 0 || projects.some((project) => project.statusCode !== 'PENDING');

    let nextStatus = contract.statusCode;
    if (allProjectsCompleted && paymentCompleted) {
      nextStatus = 'COMPLETED';
    } else if (projectStarted) {
      nextStatus = 'IN_PROGRESS';
    } else {
      nextStatus = 'ACTIVE';
    }

    if (nextStatus === contract.statusCode) return null;

    const guarded = await this.prisma.contract.updateMany({
      where: { id: contractId, statusCode: contract.statusCode },
      data: { statusCode: nextStatus, version: { increment: 1 } },
    });
    if (guarded.count === 0) return null;

    const updated = await this.prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
    await this.auditService.record({
      actorId,
      action: 'UPDATE',
      resourceType: 'Contract',
      resourceId: contractId,
      reason,
      beforeData: { statusCode: contract.statusCode },
      afterData: { statusCode: updated.statusCode },
    });
    await this.historyService.recordStatusChange({
      resourceType: 'Contract',
      resourceId: contractId,
      fromStatusCode: contract.statusCode,
      toStatusCode: updated.statusCode,
      reason,
      operatorId: actorId,
    });
    return { fromStatusCode: contract.statusCode, toStatusCode: updated.statusCode };
  }
}
