import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

type AuditEntry = {
  actorId?: string | undefined;
  action: string;
  resourceType: string;
  resourceId?: string;
  reason?: string;
  beforeData?: unknown | undefined;
  afterData?: unknown | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
};

const ACTION_LABELS: Record<string, string> = {
  CREATE: '新增',
  UPDATE: '编辑',
  SOFT_DELETE: '删除',
  DELETE: '删除',
  DISABLE: '停用',
  ENABLE: '启用',
  STATUS_CHANGE: '状态变更',
  NODE_TRANSITION: '流程节点推进',
  RENUMBER: '编号变更',
  ADJUST_AMOUNT: '金额调整',
  TERMINATE: '终止',
  PUBLISH: '发布',
  REPLACE_PERMISSIONS: '权限变更',
  HANDLE_REMINDER: '处理提醒',
  UNHANDLE_REMINDER: '撤销提醒处理',
  FILE_VIEW: '查看附件',
  FILE_DOWNLOAD: '下载附件',
  FILE_UPLOAD: '上传附件',
  FILE_DELETE: '删除附件',
};

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  Customer: '客户',
  Contract: '合同',
  Project: '项目',
  PaymentReceipt: '回款',
  CostRecord: '成本',
  ContractAmountAdjustment: '合同金额调整',
  User: '用户',
  Department: '部门',
  Role: '角色',
  FieldDefinition: '模板字段',
  StatusDefinition: '状态配置',
  WorkflowTemplate: '流程模板',
  WorkflowVersion: '流程版本',
  WorkflowNode: '流程节点',
  Reminder: '提醒',
  ReminderConfig: '提醒配置',
  FileAsset: '附件',
  Feedback: '用户反馈',
  FeedbackRouting: '反馈接收配置',
};

@Injectable()
export class AuditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry) {
    const beforeData = this.toJson(entry.beforeData);
    const afterData = this.toJson(entry.afterData);
    return this.prisma.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        reason: entry.reason ?? null,
        ...(beforeData === undefined ? {} : { beforeData }),
        ...(afterData === undefined ? {} : { afterData }),
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
      },
    });
  }

  async list(limit = 100) {
    const logs = await this.prisma.auditLog.findMany({
      take: Math.min(Math.max(limit, 1), 500),
      orderBy: { createdAt: 'desc' },
      include: { actor: { select: { id: true, username: true, displayName: true } } },
    });

    const idsByType = new Map<string, string[]>();
    for (const log of logs) {
      if (!log.resourceId) continue;
      const ids = idsByType.get(log.resourceType) ?? [];
      ids.push(log.resourceId);
      idsByType.set(log.resourceType, ids);
    }
    const ids = (type: string) => [...new Set(idsByType.get(type) ?? [])];
    const [customers, contracts, projects, payments, costs, adjustments, users, departments, roles, fields, statuses, templates, versions, nodes, reminders, files, feedbacks] = await Promise.all([
      this.prisma.customer.findMany({ where: { id: { in: ids('Customer') } }, select: { id: true, name: true } }),
      this.prisma.contract.findMany({ where: { id: { in: ids('Contract') } }, select: { id: true, contractNo: true } }),
      this.prisma.project.findMany({ where: { id: { in: ids('Project') } }, select: { id: true, projectNo: true } }),
      this.prisma.paymentReceipt.findMany({ where: { id: { in: ids('PaymentReceipt') } }, select: { id: true, receiptNo: true } }),
      this.prisma.costRecord.findMany({ where: { id: { in: ids('CostRecord') } }, select: { id: true, costType: true } }),
      this.prisma.contractAmountAdjustment.findMany({ where: { id: { in: ids('ContractAmountAdjustment') } }, select: { id: true, contract: { select: { contractNo: true } } } }),
      this.prisma.user.findMany({ where: { id: { in: ids('User') } }, select: { id: true, displayName: true, username: true } }),
      this.prisma.department.findMany({ where: { id: { in: ids('Department') } }, select: { id: true, name: true } }),
      this.prisma.role.findMany({ where: { id: { in: ids('Role') } }, select: { id: true, name: true } }),
      this.prisma.fieldDefinition.findMany({ where: { id: { in: ids('FieldDefinition') } }, select: { id: true, label: true } }),
      this.prisma.statusDefinition.findMany({ where: { id: { in: ids('StatusDefinition') } }, select: { id: true, label: true } }),
      this.prisma.workflowTemplate.findMany({ where: { id: { in: ids('WorkflowTemplate') } }, select: { id: true, name: true } }),
      this.prisma.workflowVersion.findMany({ where: { id: { in: ids('WorkflowVersion') } }, select: { id: true, version: true, template: { select: { name: true } } } }),
      this.prisma.workflowNode.findMany({ where: { id: { in: ids('WorkflowNode') } }, select: { id: true, name: true } }),
      this.prisma.reminder.findMany({ where: { id: { in: ids('Reminder') } }, select: { id: true, title: true, sourceNo: true } }),
      this.prisma.fileAsset.findMany({ where: { id: { in: ids('FileAsset') } }, select: { id: true, originalName: true } }),
      this.prisma.feedback.findMany({ where: { id: { in: ids('Feedback') } }, select: { id: true, feedbackNo: true, title: true } }),
    ]);
    const displayMaps = new Map<string, Map<string, string>>([
      ['Customer', new Map(customers.map((item) => [item.id, item.name]))],
      ['Contract', new Map(contracts.map((item) => [item.id, item.contractNo]))],
      ['Project', new Map(projects.map((item) => [item.id, item.projectNo]))],
      ['PaymentReceipt', new Map(payments.map((item) => [item.id, item.receiptNo]))],
      ['CostRecord', new Map(costs.map((item) => [item.id, `费用：${item.costType}`]))],
      ['ContractAmountAdjustment', new Map(adjustments.map((item) => [item.id, `合同：${item.contract.contractNo}`]))],
      ['User', new Map(users.map((item) => [item.id, item.displayName || item.username]))],
      ['Department', new Map(departments.map((item) => [item.id, item.name]))],
      ['Role', new Map(roles.map((item) => [item.id, item.name]))],
      ['FieldDefinition', new Map(fields.map((item) => [item.id, item.label]))],
      ['StatusDefinition', new Map(statuses.map((item) => [item.id, item.label]))],
      ['WorkflowTemplate', new Map(templates.map((item) => [item.id, item.name]))],
      ['WorkflowVersion', new Map(versions.map((item) => [item.id, `${item.template.name} v${item.version}`]))],
      ['WorkflowNode', new Map(nodes.map((item) => [item.id, item.name]))],
      ['Reminder', new Map(reminders.map((item) => [item.id, item.sourceNo || item.title]))],
      ['FileAsset', new Map(files.map((item) => [item.id, item.originalName]))],
      ['Feedback', new Map(feedbacks.map((item) => [item.id, `${item.feedbackNo}：${item.title}`]))],
    ]);

    return logs.map((log) => ({
      ...log,
      actionLabel: ACTION_LABELS[log.action] ?? '其他操作',
      resourceTypeLabel: RESOURCE_TYPE_LABELS[log.resourceType] ?? '系统记录',
      resourceDisplayId: log.resourceId
        ? displayMaps.get(log.resourceType)?.get(log.resourceId) ?? '系统记录'
        : '系统记录',
    }));
  }

  private toJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
