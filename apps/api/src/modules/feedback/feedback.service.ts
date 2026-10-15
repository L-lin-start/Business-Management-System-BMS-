import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { DocumentNumberService } from '../../infrastructure/document-number/document-number.service';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { CreateFeedbackDto, FEEDBACK_STATUS_CODES, UpdateFeedbackDto, UpdateFeedbackRoutingDto } from './dto/feedback.dto';

const FEEDBACK_STATUS_LABELS: Record<string, string> = {
  PENDING: '待处理',
  PROCESSING: '处理中',
  RESOLVED: '已解决',
  CLOSED: '已关闭',
};

const FEEDBACK_PRIORITY_LABELS: Record<string, string> = {
  LOW: '低',
  NORMAL: '普通',
  HIGH: '高',
};

@Injectable()
export class FeedbackService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(DocumentNumberService) private readonly documentNumber: DocumentNumberService,
  ) {}

  /** 所有登录用户都能提交，不检查 feedback.manage。 */
  async create(input: CreateFeedbackDto, actorId: string) {
    const year = new Date().getUTCFullYear();
    const allocated = await this.documentNumber.allocate({
      scope: 'feedback',
      prefix: 'FK',
      year,
      isAvailable: async (value) => !(await this.prisma.feedback.findUnique({ where: { feedbackNo: value }, select: { id: true } })),
    });
    const feedback = await this.prisma.feedback.create({
      data: {
        feedbackNo: allocated.value,
        title: input.title.trim(),
        content: input.content.trim(),
        category: input.category?.trim() || null,
        priority: input.priority ?? 'NORMAL',
        createdById: actorId,
      },
      include: { createdBy: { select: { id: true, displayName: true, username: true } } },
    });
    await this.auditService.record({
      actorId,
      action: 'CREATE',
      resourceType: 'Feedback',
      resourceId: feedback.id,
      afterData: { feedbackNo: feedback.feedbackNo, title: feedback.title, category: feedback.category, priority: feedback.priority },
    });
    return this.toResponse(feedback);
  }

  /** 仅有反馈处理权限且属于配置接收部门的人员能看到队列。 */
  async list(actorId: string) {
    await this.assertQueueAccess(actorId);
    const rows = await this.prisma.feedback.findMany({
      orderBy: [{ statusCode: 'asc' }, { createdAt: 'desc' }],
      include: {
        createdBy: { select: { id: true, displayName: true, username: true } },
        handledBy: { select: { id: true, displayName: true, username: true } },
      },
    });
    return { items: rows.map((row) => this.toResponse(row)), total: rows.length };
  }

  async update(id: string, input: UpdateFeedbackDto, actorId: string) {
    await this.assertQueueAccess(actorId);
    const before = await this.prisma.feedback.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('反馈不存在');
    const resolved = input.statusCode === 'RESOLVED' || input.statusCode === 'CLOSED';
    const feedback = await this.prisma.feedback.update({
      where: { id },
      data: {
        statusCode: input.statusCode,
        handlingNote: input.handlingNote === undefined ? before.handlingNote : input.handlingNote.trim() || null,
        handledById: actorId,
        resolvedAt: resolved ? (before.resolvedAt ?? new Date()) : null,
      },
      include: {
        createdBy: { select: { id: true, displayName: true, username: true } },
        handledBy: { select: { id: true, displayName: true, username: true } },
      },
    });
    await this.auditService.record({
      actorId,
      action: 'UPDATE',
      resourceType: 'Feedback',
      resourceId: id,
      beforeData: { statusCode: before.statusCode, handlingNote: before.handlingNote, handledById: before.handledById },
      afterData: { statusCode: feedback.statusCode, handlingNote: feedback.handlingNote, handledById: feedback.handledById },
      reason: `反馈状态变更为${FEEDBACK_STATUS_LABELS[feedback.statusCode] ?? feedback.statusCode}`,
    });
    return this.toResponse(feedback);
  }

  async listRouting() {
    const [departments, selected] = await Promise.all([
      this.prisma.department.findMany({
        where: { isActive: true },
        select: { id: true, name: true, code: true, parentId: true },
        orderBy: [{ name: 'asc' }],
      }),
      this.prisma.feedbackRoutingDepartment.findMany({ select: { departmentId: true } }),
    ]);
    return { departments, departmentIds: selected.map((item) => item.departmentId) };
  }

  async updateRouting(input: UpdateFeedbackRoutingDto, actorId: string) {
    const uniqueIds = [...new Set(input.departmentIds)];
    const activeDepartments = await this.prisma.department.findMany({ where: { id: { in: uniqueIds }, isActive: true }, select: { id: true, name: true } });
    if (activeDepartments.length !== uniqueIds.length) throw new NotFoundException('存在不存在或已停用的接收部门');
    const before = await this.prisma.feedbackRoutingDepartment.findMany({ select: { departmentId: true } });
    await this.prisma.$transaction(async (tx) => {
      await tx.feedbackRoutingDepartment.deleteMany();
      if (uniqueIds.length) {
        await tx.feedbackRoutingDepartment.createMany({ data: uniqueIds.map((departmentId) => ({ departmentId, updatedById: actorId })) });
      }
    });
    await this.auditService.record({
      actorId,
      action: 'UPDATE',
      resourceType: 'FeedbackRouting',
      reason: '反馈接收部门配置变更',
      beforeData: { departmentIds: before.map((item) => item.departmentId) },
      afterData: { departmentIds: uniqueIds, departmentNames: activeDepartments.map((item) => item.name) },
    });
    return this.listRouting();
  }

  private async assertQueueAccess(actorId: string) {
    const user = await this.prisma.user.findFirst({ where: { id: actorId, status: 'ACTIVE', deletedAt: null }, select: { isSystemAdmin: true } });
    if (!user) throw new ForbiddenException('当前账号不可用');
    if (user.isSystemAdmin) return;
    const matchingDepartment = await this.prisma.feedbackRoutingDepartment.findFirst({
      where: { department: { members: { some: { userId: actorId } } } },
      select: { departmentId: true },
    });
    if (!matchingDepartment) throw new ForbiddenException('当前账号不在反馈接收部门，无法查看反馈');
  }

  private toResponse(row: {
    id: string;
    feedbackNo: string;
    title: string;
    content: string;
    category: string | null;
    priority: string;
    statusCode: string;
    handlingNote: string | null;
    resolvedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    createdBy?: { id: string; displayName: string; username: string } | null;
    handledBy?: { id: string; displayName: string; username: string } | null;
  }) {
    return {
      ...row,
      statusLabel: FEEDBACK_STATUS_LABELS[row.statusCode] ?? row.statusCode,
      priorityLabel: FEEDBACK_PRIORITY_LABELS[row.priority] ?? row.priority,
    };
  }
}
