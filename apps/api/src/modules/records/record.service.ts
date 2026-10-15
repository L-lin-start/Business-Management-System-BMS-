import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataScope, Prisma } from '@prisma/client';
import { AuditService } from '../../infrastructure/audit/audit.service';
import { CustomFieldsService } from '../../infrastructure/custom-fields/custom-fields.service';
import { parseCalendarDate } from '../../infrastructure/date/calendar-date';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { OptionsService } from '../options/options.service';
import { RecordScopeService } from './record-scope.service';
import {
  ActionRecordQueryDto,
  CreateActionRecordDto,
  CreateFilingResultDto,
  CreateMailDeliveryDto,
  CreateOfficialDocumentDto,
  FilingResultQueryDto,
  MailDeliveryQueryDto,
  OfficialDocumentQueryDto,
  UpdateActionRecordDto,
  UpdateFilingResultDto,
  UpdateMailDeliveryDto,
  UpdateOfficialDocumentDto,
} from './dto/record.dto';

/** 分页参数的统一归位，避免各方法重复写 */
function readPaging(query: { page?: number; pageSize?: number }) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/** 把受控选项解析成存库值（接受编码或中文标签），未配置则按配置报错 */
async function resolveOption(
  options: OptionsService,
  moduleKey: string,
  value: string | undefined,
  label: string,
): Promise<string | null> {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  return options.assertOptionAllowed(moduleKey, trimmed, label);
}

/* ==========================================================================
   官文管理（PRD 4.5 / 8.5）
   ========================================================================== */

@Injectable()
export class OfficialDocumentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(CustomFieldsService) private readonly customFields: CustomFieldsService,
    @Inject(OptionsService) private readonly options: OptionsService,
    @Inject(RecordScopeService) private readonly scope: RecordScopeService,
  ) {}

  async list(query: OfficialDocumentQueryDto, userId: string, dataScope: DataScope) {
    const { page, pageSize, skip, take } = readPaging(query);
    const scopeWhere = await this.buildScopeWhere(userId, dataScope);
    const where: Prisma.OfficialDocumentWhereInput = {
      deletedAt: null,
      ...scopeWhere,
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.documentType ? { documentType: query.documentType } : {}),
      ...(query.needsMailOnly === 'true'
        ? { needsMailDelivery: true, mailDeliveries: { none: { deletedAt: null } } }
        : {}),
      ...(query.keyword
        ? {
            OR: [
              { documentName: { contains: query.keyword, mode: 'insensitive' } },
              { documentNo: { contains: query.keyword, mode: 'insensitive' } },
              { issuingAuthority: { contains: query.keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.officialDocument.findMany({
        where,
        orderBy: [{ deliveredAt: 'desc' }, { createdAt: 'desc' }],
        skip,
        take,
        include: {
          project: { select: { id: true, projectNo: true, projectName: true } },
          _count: { select: { mailDeliveries: true } },
        },
      }),
      this.prisma.officialDocument.count({ where }),
    ]);

    // needsMailOnly 已下推到数据库查询，确保分页和软删除记录口径一致。
    return { items, total, page, pageSize };
  }

  async getById(id: string, userId: string, dataScope: DataScope) {
    const scopeWhere = await this.buildScopeWhere(userId, dataScope);
    const document = await this.prisma.officialDocument.findFirst({
      where: { id, deletedAt: null, ...scopeWhere },
      include: {
        project: { select: { id: true, projectNo: true, projectName: true, contractId: true } },
        mailDeliveries: {
          where: { deletedAt: null },
          orderBy: { registeredAt: 'desc' },
          include: {
            sentBy: { select: { id: true, displayName: true } },
            registeredBy: { select: { id: true, displayName: true } },
          },
        },
      },
    });
    if (!document) throw new NotFoundException('官文不存在或无权查看');
    return document;
  }

  async create(input: CreateOfficialDocumentDto, actorId: string, dataScope: DataScope) {
    await this.scope.assertProjectAccess(input.projectId, actorId, dataScope);
    const customFields = await this.customFields.sanitize('official_document', input.customFields);
    const document = await this.prisma.officialDocument.create({
      data: {
        projectId: input.projectId,
        documentType: await resolveOption(this.options, 'officialDocumentType', input.documentType, '官文类型'),
        documentName: input.documentName.trim(),
        issuingAuthority: input.issuingAuthority?.trim() || null,
        documentNo: input.documentNo?.trim() || null,
        issuedAt: parseCalendarDate(input.issuedAt),
        deliveredAt: parseCalendarDate(input.deliveredAt),
        source: await resolveOption(this.options, 'officialDocumentSource', input.source, '官文来源'),
        needsMailDelivery: input.needsMailDelivery ?? false,
        note: input.note?.trim() || null,
        ...(customFields ? { customFields } : {}),
      },
      include: { project: { select: { id: true, projectNo: true, projectName: true } } },
    });
    await this.auditService.record({ actorId, action: 'CREATE', resourceType: 'OfficialDocument', resourceId: document.id, afterData: document });
    return document;
  }

  async update(id: string, input: UpdateOfficialDocumentDto, actorId: string, dataScope: DataScope) {
    const before = await this.getEditable(id, actorId, dataScope);
    const customFields = input.customFields === undefined
      ? undefined
      : await this.customFields.sanitize('official_document', input.customFields, { partial: true });
    const document = await this.prisma.officialDocument.update({
      where: { id },
      data: {
        ...(input.documentType !== undefined
          ? { documentType: await resolveOption(this.options, 'officialDocumentType', input.documentType, '官文类型') }
          : {}),
        ...(input.documentName !== undefined ? { documentName: input.documentName.trim() } : {}),
        ...(input.issuingAuthority !== undefined ? { issuingAuthority: input.issuingAuthority.trim() || null } : {}),
        ...(input.documentNo !== undefined ? { documentNo: input.documentNo.trim() || null } : {}),
        ...(input.issuedAt !== undefined ? { issuedAt: parseCalendarDate(input.issuedAt) } : {}),
        ...(input.deliveredAt !== undefined ? { deliveredAt: parseCalendarDate(input.deliveredAt) } : {}),
        ...(input.source !== undefined
          ? { source: await resolveOption(this.options, 'officialDocumentSource', input.source, '官文来源') }
          : {}),
        ...(input.needsMailDelivery !== undefined ? { needsMailDelivery: input.needsMailDelivery } : {}),
        ...(input.note !== undefined ? { note: input.note.trim() || null } : {}),
        ...(customFields !== undefined ? { customFields } : {}),
      },
    });
    await this.auditService.record({ actorId, action: 'UPDATE', resourceType: 'OfficialDocument', resourceId: id, beforeData: before, afterData: document });
    return document;
  }

  /** PRD 第七章：软删除 + 原因 + 留痕；数据保留可恢复 */
  async remove(id: string, actorId: string, dataScope: DataScope, reason?: string) {
    if (!reason?.trim()) throw new BadRequestException('请填写删除原因');
    const before = await this.getEditable(id, actorId, dataScope);
    const removed = await this.prisma.officialDocument.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.auditService.record({
      actorId,
      action: 'DELETE',
      resourceType: 'OfficialDocument',
      resourceId: id,
      reason: reason.trim(),
      beforeData: before,
      afterData: { deletedAt: removed.deletedAt },
    });
    return { id, deletedAt: removed.deletedAt };
  }

  private async getEditable(id: string, userId: string, dataScope: DataScope) {
    const scopeWhere = await this.buildScopeWhere(userId, dataScope);
    const document = await this.prisma.officialDocument.findFirst({ where: { id, deletedAt: null, ...scopeWhere } });
    if (!document) throw new NotFoundException('官文不存在或无权操作');
    return document;
  }

  /**
   * 官文的可见范围：按**所属项目**的可见性判定。
   * 不能只用「官文 → 项目 → 负责人」的简单条件，否则与项目列表的口径不一致
   * （阶段 3.6 之后"我负责的节点上的项目"也算可见）。因此逐条用 RecordScopeService 判定。
   */
  private async buildScopeWhere(userId: string, dataScope: DataScope): Promise<Prisma.OfficialDocumentWhereInput> {
    if (dataScope === 'ALL') return {};
    if (dataScope === 'NONE') return { id: '__NO_ACCESS__' };
    const projectIds = await this.visibleProjectIds(userId, dataScope);
    return { projectId: { in: projectIds } };
  }

  private async visibleProjectIds(userId: string, dataScope: DataScope): Promise<string[]> {
    return this.scope.visibleProjectIds(userId, dataScope);
  }
}

/* ==========================================================================
   邮件送达登记（PRD 4.6 / 8.6）
   ========================================================================== */

@Injectable()
export class MailDeliveryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(CustomFieldsService) private readonly customFields: CustomFieldsService,
    @Inject(OptionsService) private readonly options: OptionsService,
    @Inject(RecordScopeService) private readonly scope: RecordScopeService,
  ) {}

  async list(query: MailDeliveryQueryDto, userId: string, dataScope: DataScope) {
    const { page, pageSize, skip, take } = readPaging(query);
    const where: Prisma.MailDeliveryWhereInput = {
      deletedAt: null,
      ...(query.officialDocumentId ? { officialDocumentId: query.officialDocumentId } : {}),
      ...(query.projectId ? { officialDocument: { projectId: query.projectId } } : {}),
      ...(query.statusCode ? { statusCode: query.statusCode } : {}),
      ...(await this.scopeFilter(userId, dataScope)),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.mailDelivery.findMany({
        where,
        orderBy: [{ registeredAt: 'desc' }],
        skip,
        take,
        include: {
          officialDocument: { select: { id: true, documentName: true, documentType: true, projectId: true } },
          sentBy: { select: { id: true, displayName: true } },
          registeredBy: { select: { id: true, displayName: true } },
        },
      }),
      this.prisma.mailDelivery.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async getById(id: string, userId: string, dataScope: DataScope) {
    const record = await this.prisma.mailDelivery.findFirst({
      where: { id, deletedAt: null },
      include: {
        officialDocument: { select: { id: true, documentName: true, projectId: true } },
        sentBy: { select: { id: true, displayName: true } },
        registeredBy: { select: { id: true, displayName: true } },
      },
    });
    if (!record) throw new NotFoundException('邮件送达记录不存在');
    await this.scope.assertProjectAccess(record.officialDocument.projectId, userId, dataScope);
    return record;
  }

  async create(input: CreateMailDeliveryDto, actorId: string, dataScope: DataScope) {
    const { project } = await this.scope.resolveDocumentProject(input.officialDocumentId);
    await this.scope.assertProjectAccess(project.id, actorId, dataScope);
    const customFields = await this.customFields.sanitize('mail_delivery', input.customFields);
    const sentAt = parseCalendarDate(input.sentAt);
    const record = await this.prisma.mailDelivery.create({
      data: {
        officialDocumentId: input.officialDocumentId,
        recipientEmail: input.recipientEmail.trim(),
        sentAt,
        sentById: input.sentById ?? (sentAt ? actorId : null),
        registeredById: actorId,
        statusCode: await this.resolveStatus(input.statusCode, sentAt),
        note: input.note?.trim() || null,
        ...(customFields ? { customFields } : {}),
      },
      include: { officialDocument: { select: { id: true, documentName: true, projectId: true } } },
    });
    await this.auditService.record({ actorId, action: 'CREATE', resourceType: 'MailDelivery', resourceId: record.id, afterData: record });
    return record;
  }

  async update(id: string, input: UpdateMailDeliveryDto, actorId: string, dataScope: DataScope) {
    const before = await this.getEditable(id, actorId, dataScope);
    const customFields = input.customFields === undefined
      ? undefined
      : await this.customFields.sanitize('mail_delivery', input.customFields, { partial: true });
    const sentAt = input.sentAt === undefined ? before.sentAt : parseCalendarDate(input.sentAt);
    const statusCode = input.statusCode !== undefined
      ? (await this.resolveStatus(input.statusCode, sentAt))
      : (input.sentAt !== undefined ? await this.resolveStatus(undefined, sentAt) : undefined);
    const record = await this.prisma.mailDelivery.update({
      where: { id },
      data: {
        ...(input.recipientEmail !== undefined ? { recipientEmail: input.recipientEmail.trim() } : {}),
        ...(input.sentAt !== undefined ? { sentAt } : {}),
        ...(input.sentAt !== undefined || input.sentById !== undefined
          ? { sentById: input.sentById || (sentAt ? actorId : null) }
          : {}),
        ...(statusCode !== undefined ? { statusCode } : {}),
        ...(input.note !== undefined ? { note: input.note.trim() || null } : {}),
        ...(customFields !== undefined ? { customFields } : {}),
      },
    });
    await this.auditService.record({ actorId, action: 'UPDATE', resourceType: 'MailDelivery', resourceId: id, beforeData: before, afterData: record });
    return record;
  }

  async remove(id: string, actorId: string, dataScope: DataScope, reason?: string) {
    if (!reason?.trim()) throw new BadRequestException('请填写删除原因');
    const before = await this.getEditable(id, actorId, dataScope);
    const removed = await this.prisma.mailDelivery.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.auditService.record({
      actorId,
      action: 'DELETE',
      resourceType: 'MailDelivery',
      resourceId: id,
      reason: reason.trim(),
      beforeData: before,
      afterData: { deletedAt: removed.deletedAt },
    });
    return { id, deletedAt: removed.deletedAt };
  }

  /** 未填状态时按"有发送日期=已发送，否则待发送"推断，减少人工选择 */
  private async resolveStatus(statusCode: string | undefined, sentAt: Date | null) {
    if (statusCode?.trim()) {
      return (await resolveOption(this.options, 'mailDeliveryStatus', statusCode, '送达状态')) ?? 'PENDING';
    }
    return sentAt ? 'SENT' : 'PENDING';
  }

  private async getEditable(id: string, userId: string, dataScope: DataScope) {
    const record = await this.prisma.mailDelivery.findFirst({
      where: { id, deletedAt: null },
      include: { officialDocument: { select: { projectId: true } } },
    });
    if (!record) throw new NotFoundException('邮件送达记录不存在');
    await this.scope.assertProjectAccess(record.officialDocument.projectId, userId, dataScope);
    return record;
  }

  private async scopeFilter(userId: string, dataScope: DataScope): Promise<Prisma.MailDeliveryWhereInput> {
    if (dataScope === 'ALL') return {};
    if (dataScope === 'NONE') return { id: '__NO_ACCESS__' };
    return { officialDocument: { projectId: { in: await this.scope.visibleProjectIds(userId, dataScope) } } };
  }
}

/* ==========================================================================
   动作记录（PRD 4.8）
   ========================================================================== */

@Injectable()
export class ActionRecordService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(CustomFieldsService) private readonly customFields: CustomFieldsService,
    @Inject(OptionsService) private readonly options: OptionsService,
    @Inject(RecordScopeService) private readonly scope: RecordScopeService,
  ) {}

  async list(query: ActionRecordQueryDto, userId: string, dataScope: DataScope) {
    const { page, pageSize, skip, take } = readPaging(query);
    const where: Prisma.ActionRecordWhereInput = {
      deletedAt: null,
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.actionType ? { actionType: query.actionType } : {}),
      ...(await this.scopeFilter(userId, dataScope)),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.actionRecord.findMany({
        where,
        orderBy: [{ actionAt: 'desc' }, { createdAt: 'desc' }],
        skip,
        take,
        include: {
          project: { select: { id: true, projectNo: true, projectName: true } },
          operator: { select: { id: true, displayName: true } },
        },
      }),
      this.prisma.actionRecord.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async create(input: CreateActionRecordDto, actorId: string, dataScope: DataScope) {
    await this.scope.assertProjectAccess(input.projectId, actorId, dataScope);
    const customFields = await this.customFields.sanitize('action_record', input.customFields);
    const record = await this.prisma.actionRecord.create({
      data: {
        projectId: input.projectId,
        actionType: await this.resolveActionType(input.actionType),
        actionAt: parseCalendarDate(input.actionAt) ?? new Date(),
        operatorId: input.operatorId ?? actorId,
        note: input.note?.trim() || null,
        ...(customFields ? { customFields } : {}),
      },
      include: { project: { select: { id: true, projectNo: true, projectName: true } }, operator: { select: { id: true, displayName: true } } },
    });
    await this.auditService.record({ actorId, action: 'CREATE', resourceType: 'ActionRecord', resourceId: record.id, afterData: record });
    return record;
  }

  async update(id: string, input: UpdateActionRecordDto, actorId: string, dataScope: DataScope) {
    const before = await this.getEditable(id, actorId, dataScope);
    const customFields = input.customFields === undefined
      ? undefined
      : await this.customFields.sanitize('action_record', input.customFields, { partial: true });
    const record = await this.prisma.actionRecord.update({
      where: { id },
      data: {
        ...(input.actionType !== undefined ? { actionType: await this.resolveActionType(input.actionType) } : {}),
        ...(input.actionAt !== undefined ? { actionAt: parseCalendarDate(input.actionAt) ?? before.actionAt } : {}),
        ...(input.operatorId !== undefined ? { operatorId: input.operatorId || null } : {}),
        ...(input.note !== undefined ? { note: input.note.trim() || null } : {}),
        ...(customFields !== undefined ? { customFields } : {}),
      },
    });
    await this.auditService.record({ actorId, action: 'UPDATE', resourceType: 'ActionRecord', resourceId: id, beforeData: before, afterData: record });
    return record;
  }

  async remove(id: string, actorId: string, dataScope: DataScope, reason?: string) {
    if (!reason?.trim()) throw new BadRequestException('请填写删除原因');
    const before = await this.getEditable(id, actorId, dataScope);
    const removed = await this.prisma.actionRecord.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.auditService.record({
      actorId,
      action: 'DELETE',
      resourceType: 'ActionRecord',
      resourceId: id,
      reason: reason.trim(),
      beforeData: before,
      afterData: { deletedAt: removed.deletedAt },
    });
    return { id, deletedAt: removed.deletedAt };
  }

  /**
   * 动作类型（PRD 4.8「动作类型可自定义」）。
   * 由系统 B 的 StatusDefinition 承载：配了就必须是配置好的选项，没配就允许自由填写，
   * 避免刚上线还没配置时完全无法录入。
   */
  private async resolveActionType(value: string) {
    const trimmed = value.trim();
    if (!trimmed) throw new BadRequestException('请填写动作类型');
    const configured = await this.options.listOptions('actionType');
    if (configured.length === 0) return trimmed;
    return this.options.assertOptionAllowed('actionType', trimmed, '动作类型');
  }

  private async getEditable(id: string, userId: string, dataScope: DataScope) {
    const record = await this.prisma.actionRecord.findFirst({ where: { id, deletedAt: null } });
    if (!record) throw new NotFoundException('动作记录不存在');
    await this.scope.assertProjectAccess(record.projectId, userId, dataScope);
    return record;
  }

  private async scopeFilter(userId: string, dataScope: DataScope): Promise<Prisma.ActionRecordWhereInput> {
    if (dataScope === 'ALL') return {};
    if (dataScope === 'NONE') return { id: '__NO_ACCESS__' };
    return { projectId: { in: await this.visibleProjectIds(userId, dataScope) } };
  }

  private async visibleProjectIds(userId: string, dataScope: DataScope): Promise<string[]> {
    return this.scope.visibleProjectIds(userId, dataScope);
  }
}

/* ==========================================================================
   申报结果记录（PRD 4.9）
   ========================================================================== */

@Injectable()
export class FilingResultService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(CustomFieldsService) private readonly customFields: CustomFieldsService,
    @Inject(OptionsService) private readonly options: OptionsService,
    @Inject(RecordScopeService) private readonly scope: RecordScopeService,
  ) {}

  async list(query: FilingResultQueryDto, userId: string, dataScope: DataScope) {
    const { page, pageSize, skip, take } = readPaging(query);
    const where: Prisma.FilingResultWhereInput = {
      deletedAt: null,
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.resultCode ? { resultCode: query.resultCode } : {}),
      ...(await this.scopeFilter(userId, dataScope)),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.filingResult.findMany({
        where,
        orderBy: [{ recordedAt: 'desc' }, { createdAt: 'desc' }],
        skip,
        take,
        include: {
          project: { select: { id: true, projectNo: true, projectName: true } },
          recordedBy: { select: { id: true, displayName: true } },
        },
      }),
      this.prisma.filingResult.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async create(input: CreateFilingResultDto, actorId: string, dataScope: DataScope) {
    await this.scope.assertProjectAccess(input.projectId, actorId, dataScope);
    const customFields = await this.customFields.sanitize('filing_result', input.customFields);
    const record = await this.prisma.filingResult.create({
      data: {
        projectId: input.projectId,
        resultCode: await this.resolveResultCode(input.resultCode),
        recordedAt: parseCalendarDate(input.recordedAt) ?? new Date(),
        recordedById: input.recordedById ?? actorId,
        note: input.note?.trim() || null,
        ...(customFields ? { customFields } : {}),
      },
      include: { project: { select: { id: true, projectNo: true, projectName: true } }, recordedBy: { select: { id: true, displayName: true } } },
    });
    await this.auditService.record({ actorId, action: 'CREATE', resourceType: 'FilingResult', resourceId: record.id, afterData: record });
    return record;
  }

  /** PRD 4.9：状态可修改、修改留痕（由 auditService 记录 before/after） */
  async update(id: string, input: UpdateFilingResultDto, actorId: string, dataScope: DataScope) {
    const before = await this.getEditable(id, actorId, dataScope);
    const customFields = input.customFields === undefined
      ? undefined
      : await this.customFields.sanitize('filing_result', input.customFields, { partial: true });
    const record = await this.prisma.filingResult.update({
      where: { id },
      data: {
        ...(input.resultCode !== undefined ? { resultCode: await this.resolveResultCode(input.resultCode) } : {}),
        ...(input.recordedAt !== undefined ? { recordedAt: parseCalendarDate(input.recordedAt) ?? before.recordedAt } : {}),
        ...(input.recordedById !== undefined ? { recordedById: input.recordedById || null } : {}),
        ...(input.note !== undefined ? { note: input.note.trim() || null } : {}),
        ...(customFields !== undefined ? { customFields } : {}),
      },
    });
    await this.auditService.record({ actorId, action: 'UPDATE', resourceType: 'FilingResult', resourceId: id, beforeData: before, afterData: record });
    return record;
  }

  async remove(id: string, actorId: string, dataScope: DataScope, reason?: string) {
    if (!reason?.trim()) throw new BadRequestException('请填写删除原因');
    const before = await this.getEditable(id, actorId, dataScope);
    const removed = await this.prisma.filingResult.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.auditService.record({
      actorId,
      action: 'DELETE',
      resourceType: 'FilingResult',
      resourceId: id,
      reason: reason.trim(),
      beforeData: before,
      afterData: { deletedAt: removed.deletedAt },
    });
    return { id, deletedAt: removed.deletedAt };
  }

  private async resolveResultCode(value: string) {
    const trimmed = value.trim();
    if (!trimmed) throw new BadRequestException('请选择申报结果');
    return this.options.assertOptionAllowed('filingResult', trimmed, '申报结果');
  }

  private async getEditable(id: string, userId: string, dataScope: DataScope) {
    const record = await this.prisma.filingResult.findFirst({ where: { id, deletedAt: null } });
    if (!record) throw new NotFoundException('申报结果记录不存在');
    await this.scope.assertProjectAccess(record.projectId, userId, dataScope);
    return record;
  }

  private async scopeFilter(userId: string, dataScope: DataScope): Promise<Prisma.FilingResultWhereInput> {
    if (dataScope === 'ALL') return {};
    if (dataScope === 'NONE') return { id: '__NO_ACCESS__' };
    return { projectId: { in: await this.scope.visibleProjectIds(userId, dataScope) } };
  }
}
