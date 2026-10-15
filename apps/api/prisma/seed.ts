import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const roles = [
  { code: 'SYSTEM_ADMIN', name: '系统管理员', isSystem: true },
  { code: 'GENERAL_MANAGER', name: '总经理', isSystem: true },
  { code: 'SALES', name: '销售', isSystem: true },
  { code: 'PATENT_AGENT', name: '专利代理人', isSystem: true },
  { code: 'TRADEMARK_AGENT', name: '商标代理人', isSystem: true },
  { code: 'PROCESS_STAFF', name: '流程人员', isSystem: true },
  { code: 'FILING_REVIEWER', name: '申报复核人', isSystem: true },
  { code: 'FINANCE', name: '财务', isSystem: true },
] as const;

const permissions = [
  ['system.admin.access', '进入管理系统', 'ADMIN', 'system', 'access'],
  ['customer.read', '查看客户', 'FUNCTION', 'customer', 'read'],
  ['customer.manage', '编辑客户', 'OPERATION', 'customer', 'manage'],
  ['customer.delete', '删除客户', 'OPERATION', 'customer', 'delete'],
  ['customer.export', '导出客户', 'OPERATION', 'customer', 'export'],
  ['contract.read', '查看合同', 'FUNCTION', 'contract', 'read'],
  ['contract.manage', '编辑合同', 'OPERATION', 'contract', 'manage'],
  ['contract.delete', '删除合同', 'OPERATION', 'contract', 'delete'],
  ['contract.export', '导出合同', 'OPERATION', 'contract', 'export'],
  ['attachment.read', '查看附件', 'FUNCTION', 'attachment', 'read'],
  ['attachment.download', '下载附件', 'OPERATION', 'attachment', 'download'],
  ['attachment.upload', '上传附件', 'OPERATION', 'attachment', 'upload'],
  ['attachment.delete', '删除附件', 'OPERATION', 'attachment', 'delete'],
  ['project.read', '查看项目', 'FUNCTION', 'project', 'read'],
  ['project.manage', '编辑项目', 'OPERATION', 'project', 'manage'],
  ['project.delete', '删除项目', 'OPERATION', 'project', 'delete'],
  ['project.export', '导出项目', 'OPERATION', 'project', 'export'],
  // 回款采用单一权限点：拥有“编辑回款”即可查看、新增、修改、删除和导出回款。
  // 数据范围仍由 RolePermission.dataScope 单独控制。
  ['payment.manage', '编辑回款', 'OPERATION', 'payment', 'manage'],
  ['cost.read', '查看成本', 'FUNCTION', 'cost', 'read'],
  ['cost.manage', '编辑成本', 'OPERATION', 'cost', 'manage'],
  ['cost.delete', '删除成本', 'OPERATION', 'cost', 'delete'],
  ['cost.export', '导出成本', 'OPERATION', 'cost', 'export'],
  // 以下权限点在开发过程中曾直接写入数据库、漏在种子之外，导致重新播种后授权被静默跳过
  // （rolePermissionDefinitions 里引用了不存在的权限码，`if (!permission) continue` 会直接忽略）。
  // 补齐后，权限点与授权定义都能由种子完整重建。
  ['project.transition', '推进项目节点', 'OPERATION', 'project', 'transition'],
  ['contract.terminate', '终止合同', 'OPERATION', 'contract', 'terminate'],
  ['reminder.read', '查看提醒', 'FUNCTION', 'reminder', 'read'],
  ['reminder.handle', '处理提醒', 'OPERATION', 'reminder', 'handle'],
  // 用户反馈：提交不需要权限；进入技术处理队列由该权限点控制，数据范围再由接收部门配置收口。
  ['feedback.manage', '处理反馈', 'OPERATION', 'feedback', 'manage'],
  // 合同/项目的附属业务数据（PRD 2.2）：官文管理、邮件送达登记、动作记录、申报结果记录。
  // 每类按「查看 / 编辑 / 删除」三个权限点；数据范围仍由 RolePermission.dataScope 单独控制。
  ['official_document.read', '查看官文', 'FUNCTION', 'official_document', 'read'],
  ['official_document.manage', '编辑官文', 'OPERATION', 'official_document', 'manage'],
  ['official_document.delete', '删除官文', 'OPERATION', 'official_document', 'delete'],
  ['mail_delivery.read', '查看邮件送达', 'FUNCTION', 'mail_delivery', 'read'],
  ['mail_delivery.manage', '编辑邮件送达', 'OPERATION', 'mail_delivery', 'manage'],
  ['mail_delivery.delete', '删除邮件送达', 'OPERATION', 'mail_delivery', 'delete'],
  ['action_record.read', '查看动作记录', 'FUNCTION', 'action_record', 'read'],
  ['action_record.manage', '编辑动作记录', 'OPERATION', 'action_record', 'manage'],
  ['action_record.delete', '删除动作记录', 'OPERATION', 'action_record', 'delete'],
  ['filing_result.read', '查看申报结果', 'FUNCTION', 'filing_result', 'read'],
  ['filing_result.manage', '编辑申报结果', 'OPERATION', 'filing_result', 'manage'],
  ['filing_result.delete', '删除申报结果', 'OPERATION', 'filing_result', 'delete'],
] as const;

const contractFieldDefinitions = [
  { moduleKey: 'contract', fieldKey: 'contractNo', label: '合同编号', fieldType: 'TEXT', isRequired: true, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 1 },
  { moduleKey: 'contract', fieldKey: 'customerId', label: '所属客户', fieldType: 'RELATION', isRequired: true, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 2 },
  { moduleKey: 'contract', fieldKey: 'amount', label: '不含税金额', fieldType: 'NUMBER', isRequired: true, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 3 },
  { moduleKey: 'contract', fieldKey: 'contractType', label: '合同类型', fieldType: 'TEXT', isRequired: false, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 4 },
  { moduleKey: 'contract', fieldKey: 'itemCount', label: '件数', fieldType: 'NUMBER', isRequired: true, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 5 },
  { moduleKey: 'contract', fieldKey: 'autoGenerateProjects', label: '按件数自动生成项目', fieldType: 'BOOLEAN', isRequired: false, isSystem: true, isListVisible: false, isSearchable: false, sortOrder: 6 },
  { moduleKey: 'contract', fieldKey: 'signedAt', label: '签订日期', fieldType: 'DATE', isRequired: false, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 7 },
  { moduleKey: 'contract', fieldKey: 'expiryDate', label: '合同到期日', fieldType: 'DATE', isRequired: false, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 8 },
  { moduleKey: 'contract', fieldKey: 'businessStartAt', label: '业务起算日期', fieldType: 'DATE', isRequired: false, isSystem: true, isListVisible: false, isSearchable: false, sortOrder: 9 },
  { moduleKey: 'contract', fieldKey: 'statusCode', label: '合同状态', fieldType: 'SELECT', isRequired: true, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 10 },
];

const customerFieldDefinitions = [
  { moduleKey: 'customer', fieldKey: 'name', label: '客户名称', fieldType: 'TEXT', isRequired: true, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 1 },
  { moduleKey: 'customer', fieldKey: 'customerType', label: '客户类型', fieldType: 'TEXT', isRequired: false, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 2 },
  { moduleKey: 'customer', fieldKey: 'contactName', label: '联系人', fieldType: 'TEXT', isRequired: false, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 3 },
  { moduleKey: 'customer', fieldKey: 'phone', label: '联系电话', fieldType: 'TEXT', isRequired: false, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 4 },
  { moduleKey: 'customer', fieldKey: 'address', label: '地址', fieldType: 'TEXT', isRequired: false, isSystem: true, isListVisible: false, isSearchable: false, sortOrder: 5 },
];

const projectFieldDefinitions = [
  { moduleKey: 'project', fieldKey: 'projectNo', label: '项目编号', fieldType: 'TEXT', isRequired: true, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 1 },
  { moduleKey: 'project', fieldKey: 'contractId', label: '所属合同', fieldType: 'RELATION', isRequired: true, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 2 },
  { moduleKey: 'project', fieldKey: 'projectName', label: '项目名称', fieldType: 'TEXT', isRequired: true, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 3 },
  { moduleKey: 'project', fieldKey: 'projectType', label: '项目类型', fieldType: 'TEXT', isRequired: false, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 4 },
  { moduleKey: 'project', fieldKey: 'statusCode', label: '项目状态', fieldType: 'SELECT', isRequired: true, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 5 },
];

const paymentFieldDefinitions = [
  { moduleKey: 'payment', fieldKey: 'amount', label: '回款金额', fieldType: 'NUMBER', isRequired: true, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 1 },
  { moduleKey: 'payment', fieldKey: 'receivedAt', label: '回款日期', fieldType: 'DATE', isRequired: true, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 2 },
  { moduleKey: 'payment', fieldKey: 'paymentMethod', label: '回款方式', fieldType: 'TEXT', isRequired: false, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 3 },
  { moduleKey: 'payment', fieldKey: 'note', label: '备注', fieldType: 'TEXT', isRequired: false, isSystem: true, isListVisible: false, isSearchable: false, sortOrder: 4 },
];

const costFieldDefinitions = [
  { moduleKey: 'cost', fieldKey: 'costType', label: '费用类型', fieldType: 'TEXT', isRequired: true, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 1 },
  { moduleKey: 'cost', fieldKey: 'amount', label: '费用金额', fieldType: 'NUMBER', isRequired: true, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 2 },
  { moduleKey: 'cost', fieldKey: 'incurredAt', label: '发生日期', fieldType: 'DATE', isRequired: true, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 3 },
];

/**
 * 附属业务数据的字段定义（PRD 8.5 / 8.6 / 4.8 / 4.9）。
 *
 * 这些都是 `isSystem: true` 的内置字段——取值由业务表的**真实列**承载，
 * 登记在这里是为了让系统 B「模块字段」页能统一展示与排序，也让系统 A 的表格/表单
 * 按同一份定义渲染，避免前后端各写一套列。
 *
 * 注意：内置字段的删除/停用由系统 B 控制（PRD 要求预置字段也能删）。
 * 删除不会 DROP 数据库列，只是让它不再出现在录入表单与列表中，已录入的值保留可恢复；
 * 依赖该字段的功能（如按送达日推算时限）会优雅降级为提示，而不是报错。
 */
const officialDocumentFieldDefinitions = [
  { moduleKey: 'official_document', fieldKey: 'documentType', label: '官文类型', fieldType: 'TEXT', isRequired: false, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 1 },
  { moduleKey: 'official_document', fieldKey: 'documentName', label: '官文名称', fieldType: 'TEXT', isRequired: true, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 2 },
  { moduleKey: 'official_document', fieldKey: 'issuingAuthority', label: '发文机构', fieldType: 'TEXT', isRequired: false, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 3 },
  { moduleKey: 'official_document', fieldKey: 'documentNo', label: '官文编号', fieldType: 'TEXT', isRequired: false, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 4 },
  { moduleKey: 'official_document', fieldKey: 'issuedAt', label: '发文日', fieldType: 'DATE', isRequired: false, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 5 },
  { moduleKey: 'official_document', fieldKey: 'deliveredAt', label: '送达日', fieldType: 'DATE', isRequired: false, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 6 },
  { moduleKey: 'official_document', fieldKey: 'source', label: '来源', fieldType: 'TEXT', isRequired: false, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 7 },
  { moduleKey: 'official_document', fieldKey: 'needsMailDelivery', label: '是否需邮件送达', fieldType: 'BOOLEAN', isRequired: false, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 8 },
  { moduleKey: 'official_document', fieldKey: 'note', label: '备注', fieldType: 'TEXT', isRequired: false, isSystem: true, isListVisible: false, isSearchable: false, sortOrder: 9 },
];

const mailDeliveryFieldDefinitions = [
  { moduleKey: 'mail_delivery', fieldKey: 'recipientEmail', label: '主收件人邮箱', fieldType: 'TEXT', isRequired: true, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 1 },
  { moduleKey: 'mail_delivery', fieldKey: 'sentAt', label: '实际发送日期', fieldType: 'DATE', isRequired: false, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 2 },
  { moduleKey: 'mail_delivery', fieldKey: 'sentById', label: '发送人', fieldType: 'USER', isRequired: false, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 3 },
  { moduleKey: 'mail_delivery', fieldKey: 'registeredById', label: '登记人', fieldType: 'USER', isRequired: false, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 4 },
  { moduleKey: 'mail_delivery', fieldKey: 'registeredAt', label: '登记时间', fieldType: 'DATE', isRequired: false, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 5 },
  { moduleKey: 'mail_delivery', fieldKey: 'statusCode', label: '状态', fieldType: 'TEXT', isRequired: false, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 6 },
  { moduleKey: 'mail_delivery', fieldKey: 'note', label: '备注', fieldType: 'TEXT', isRequired: false, isSystem: true, isListVisible: false, isSearchable: false, sortOrder: 7 },
];

const actionRecordFieldDefinitions = [
  { moduleKey: 'action_record', fieldKey: 'actionType', label: '动作类型', fieldType: 'TEXT', isRequired: true, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 1 },
  { moduleKey: 'action_record', fieldKey: 'actionAt', label: '实际日期', fieldType: 'DATE', isRequired: true, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 2 },
  { moduleKey: 'action_record', fieldKey: 'operatorId', label: '操作人', fieldType: 'USER', isRequired: false, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 3 },
  { moduleKey: 'action_record', fieldKey: 'note', label: '说明', fieldType: 'TEXT', isRequired: false, isSystem: true, isListVisible: false, isSearchable: false, sortOrder: 4 },
];

const filingResultFieldDefinitions = [
  { moduleKey: 'filing_result', fieldKey: 'resultCode', label: '申报结果', fieldType: 'TEXT', isRequired: true, isSystem: true, isListVisible: true, isSearchable: true, sortOrder: 1 },
  { moduleKey: 'filing_result', fieldKey: 'recordedAt', label: '记录日期', fieldType: 'DATE', isRequired: true, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 2 },
  { moduleKey: 'filing_result', fieldKey: 'recordedById', label: '记录人', fieldType: 'USER', isRequired: false, isSystem: true, isListVisible: true, isSearchable: false, sortOrder: 3 },
  { moduleKey: 'filing_result', fieldKey: 'note', label: '说明', fieldType: 'TEXT', isRequired: false, isSystem: true, isListVisible: false, isSearchable: false, sortOrder: 4 },
];

/**
 * 自定义字段（存进各模块的 customFields JSON 列，由 CustomFieldsService 校验）。
 * isSystem: true 表示字段由业务表列承载（内置），只用于系统 B 的展示配置，不参与 customFields 校验。
 * payment / cost 目前没有 customFields 列，因此只登记内置字段，不预置自定义字段，避免配了不生效。
 */
const customFieldDefinitions = [
  { moduleKey: 'customer', fieldKey: 'customerSource', label: '客户来源', fieldType: 'SELECT', isRequired: false, isSystem: false, isListVisible: true, isSearchable: false, sortOrder: 6, config: { options: ['线上推广', '老客户介绍', '展会', '电话拜访', '其他'] } },
  { moduleKey: 'contract', fieldKey: 'region', label: '所属地区', fieldType: 'SELECT', isRequired: false, isSystem: false, isListVisible: true, isSearchable: false, sortOrder: 11, config: { options: ['华东', '华南', '华北', '华中', '西南', '西北', '东北'] } },
  { moduleKey: 'project', fieldKey: 'applicationNo', label: '申请号', fieldType: 'TEXT', isRequired: false, isSystem: false, isListVisible: true, isSearchable: true, sortOrder: 6 },
  { moduleKey: 'project', fieldKey: 'legalStatus', label: '法律状态', fieldType: 'TEXT', isRequired: false, isSystem: false, isListVisible: false, isSearchable: false, sortOrder: 7 },
];

const fieldDefinitions = [
  ...contractFieldDefinitions,
  ...customerFieldDefinitions,
  ...projectFieldDefinitions,
  ...paymentFieldDefinitions,
  ...costFieldDefinitions,
  ...officialDocumentFieldDefinitions,
  ...mailDeliveryFieldDefinitions,
  ...actionRecordFieldDefinitions,
  ...filingResultFieldDefinitions,
  ...customFieldDefinitions,
] as const;

/**
 * 状态枚举种子（PRD 4.2 / 4.3 / 5.5）。
 * 数据库里继续用稳定英文编码，界面展示中文名称，避免把展示文案写死进业务数据。
 */
const statusDefinitions = [
  { moduleKey: 'contract', code: 'ACTIVE', label: '生效', color: '#15803d', statisticsCode: 'IN_PROGRESS', sortOrder: 1 },
  { moduleKey: 'contract', code: 'IN_PROGRESS', label: '执行中', color: '#1d4ed8', statisticsCode: 'IN_PROGRESS', sortOrder: 2 },
  { moduleKey: 'contract', code: 'COMPLETED', label: '已完成', color: '#0f766e', statisticsCode: 'COMPLETED', sortOrder: 3 },
  { moduleKey: 'contract', code: 'TERMINATED', label: '已终止', color: '#b91c1c', statisticsCode: 'TERMINATED', sortOrder: 4 },
  { moduleKey: 'project', code: 'PENDING', label: '待完成', color: '#64748b', statisticsCode: 'PENDING', sortOrder: 1 },
  { moduleKey: 'project', code: 'IN_PROGRESS', label: '进行', color: '#1d4ed8', statisticsCode: 'IN_PROGRESS', sortOrder: 2 },
  { moduleKey: 'project', code: 'COMPLETED', label: '完成', color: '#0f766e', statisticsCode: 'COMPLETED', sortOrder: 3 },
  { moduleKey: 'project', code: 'TERMINATED', label: '已终止', color: '#b91c1c', statisticsCode: 'TERMINATED', sortOrder: 4 },
  { moduleKey: 'project', code: 'EXCEPTION', label: '异常', color: '#b45309', statisticsCode: 'EXCEPTION', sortOrder: 5 },

  // 合同类型：下拉选择，不接受自由文本（PRD 8.2 默认值）
  { moduleKey: 'contractType', code: 'PATENT', label: '专利', color: null, statisticsCode: null, sortOrder: 1 },
  { moduleKey: 'contractType', code: 'TRADEMARK', label: '商标', color: null, statisticsCode: null, sortOrder: 2 },
  { moduleKey: 'contractType', code: 'COPYRIGHT', label: '软著', color: null, statisticsCode: null, sortOrder: 3 },
  { moduleKey: 'contractType', code: 'PROJECT', label: '项目', color: null, statisticsCode: null, sortOrder: 4 },
  { moduleKey: 'contractType', code: 'OTHER', label: '其他', color: null, statisticsCode: null, sortOrder: 5 },

  // 项目类型：下拉选择（PRD 8.3）
  { moduleKey: 'projectType', code: 'PATENT', label: '专利', color: null, statisticsCode: null, sortOrder: 1 },
  { moduleKey: 'projectType', code: 'TRADEMARK', label: '商标', color: null, statisticsCode: null, sortOrder: 2 },
  { moduleKey: 'projectType', code: 'COPYRIGHT', label: '软著', color: null, statisticsCode: null, sortOrder: 3 },
  { moduleKey: 'projectType', code: 'PROJECT', label: '项目', color: null, statisticsCode: null, sortOrder: 4 },

  // 以下枚举原先是直接在数据库里改的、没进种子（重播种子会丢），这里补齐。
  // 付款方式（PRD 8.2）
  { moduleKey: 'paymentTerm', code: 'FULL', label: '全款', color: null, statisticsCode: null, sortOrder: 1 },
  { moduleKey: 'paymentTerm', code: 'INSTALLMENT', label: '分期', color: null, statisticsCode: null, sortOrder: 2 },
  { moduleKey: 'paymentTerm', code: 'BY_PROGRESS', label: '按进度', color: null, statisticsCode: null, sortOrder: 3 },

  // 合同金额调整类型（阶段 3.1：退款/折扣/坏账/部分豁免）
  { moduleKey: 'adjustType', code: 'REFUND', label: '退款', color: null, statisticsCode: null, sortOrder: 1 },
  { moduleKey: 'adjustType', code: 'DISCOUNT', label: '折扣', color: null, statisticsCode: null, sortOrder: 2 },
  { moduleKey: 'adjustType', code: 'BAD_DEBT', label: '坏账', color: null, statisticsCode: null, sortOrder: 3 },
  { moduleKey: 'adjustType', code: 'WAIVER', label: '部分豁免', color: null, statisticsCode: null, sortOrder: 4 },
  { moduleKey: 'adjustType', code: 'OTHER', label: '其他', color: null, statisticsCode: null, sortOrder: 5 },

  // 合同终止类型（PRD 4.2 / 4.11）
  { moduleKey: 'terminationType', code: 'CUSTOMER_REQUEST', label: '客户要求终止', color: null, statisticsCode: null, sortOrder: 1 },
  { moduleKey: 'terminationType', code: 'REFUND', label: '退款', color: null, statisticsCode: null, sortOrder: 2 },
  { moduleKey: 'terminationType', code: 'TRANSFER_BUSINESS', label: '转业务', color: null, statisticsCode: null, sortOrder: 3 },
  { moduleKey: 'terminationType', code: 'REJECTED', label: '驳回', color: null, statisticsCode: null, sortOrder: 4 },
  { moduleKey: 'terminationType', code: 'OTHER', label: '其他', color: null, statisticsCode: null, sortOrder: 5 },

  // 未完成项目的处理方式（PRD 4.2）
  { moduleKey: 'unfinishedProjectAction', code: 'TERMINATE', label: '项目一并终止', color: null, statisticsCode: null, sortOrder: 1 },
  { moduleKey: 'unfinishedProjectAction', code: 'KEEP_RUNNING', label: '项目继续执行', color: null, statisticsCode: null, sortOrder: 2 },
  { moduleKey: 'unfinishedProjectAction', code: 'MOVE_TO_NEW', label: '转入新合同', color: null, statisticsCode: null, sortOrder: 3 },

  // 未回款的处理方式（PRD 4.2）
  { moduleKey: 'unpaidAmountAction', code: 'WRITE_OFF', label: '全额核销（不再收取）', color: null, statisticsCode: null, sortOrder: 1 },
  { moduleKey: 'unpaidAmountAction', code: 'PARTIAL_WAIVE', label: '部分豁免', color: null, statisticsCode: null, sortOrder: 2 },
  { moduleKey: 'unpaidAmountAction', code: 'KEEP_CLAIM', label: '继续追讨', color: null, statisticsCode: null, sortOrder: 3 },
  { moduleKey: 'unpaidAmountAction', code: 'REFUND_PAID', label: '已收款需退回', color: null, statisticsCode: null, sortOrder: 4 },

  // 邮件送达状态（PRD 4.6）
  { moduleKey: 'mailDeliveryStatus', code: 'PENDING', label: '待发送', color: '#b45309', statisticsCode: null, sortOrder: 1 },
  { moduleKey: 'mailDeliveryStatus', code: 'SENT', label: '已发送', color: '#15803d', statisticsCode: null, sortOrder: 2 },
  { moduleKey: 'mailDeliveryStatus', code: 'FAILED', label: '发送失败', color: '#b91c1c', statisticsCode: null, sortOrder: 3 },
  { moduleKey: 'mailDeliveryStatus', code: 'NOT_REQUIRED', label: '无需发送', color: '#64748b', statisticsCode: null, sortOrder: 4 },

  // 申报结果（PRD 4.9：通过 / 不通过 / 待重做）
  { moduleKey: 'filingResult', code: 'PASSED', label: '通过', color: '#15803d', statisticsCode: null, sortOrder: 1 },
  { moduleKey: 'filingResult', code: 'REJECTED', label: '不通过', color: '#b91c1c', statisticsCode: null, sortOrder: 2 },
  { moduleKey: 'filingResult', code: 'REDO', label: '待重做', color: '#b45309', statisticsCode: null, sortOrder: 3 },

  // 官文类型（PRD 8.5；不同类型可配不同时限天数，供「自动生成时限」使用）
  { moduleKey: 'officialDocumentType', code: 'ACCEPTANCE_NOTICE', label: '受理通知书', color: null, statisticsCode: null, sortOrder: 1 },
  { moduleKey: 'officialDocumentType', code: 'OFFICE_ACTION', label: '审查意见通知书', color: null, statisticsCode: null, sortOrder: 2 },
  { moduleKey: 'officialDocumentType', code: 'GRANT_NOTICE', label: '授权通知书', color: null, statisticsCode: null, sortOrder: 3 },
  { moduleKey: 'officialDocumentType', code: 'CERTIFICATE', label: '证书', color: null, statisticsCode: null, sortOrder: 4 },
  { moduleKey: 'officialDocumentType', code: 'OTHER', label: '其他', color: null, statisticsCode: null, sortOrder: 5 },

  // 官文来源（PRD 8.5）
  { moduleKey: 'officialDocumentSource', code: 'OFFICIAL_SYSTEM', label: '官方系统', color: null, statisticsCode: null, sortOrder: 1 },
  { moduleKey: 'officialDocumentSource', code: 'EMAIL', label: '邮件', color: null, statisticsCode: null, sortOrder: 2 },
  { moduleKey: 'officialDocumentSource', code: 'OFFLINE', label: '线下递交', color: null, statisticsCode: null, sortOrder: 3 },

  // 动作类型（PRD 4.8「动作类型可自定义」）：给一组常见起点，可在系统 B 增删改
  { moduleKey: 'actionType', code: 'SUBMIT', label: '提交申请', color: null, statisticsCode: null, sortOrder: 1 },
  { moduleKey: 'actionType', code: 'RESPOND_OA', label: '答复审查意见', color: null, statisticsCode: null, sortOrder: 2 },
  { moduleKey: 'actionType', code: 'SUPPLEMENT', label: '补正', color: null, statisticsCode: null, sortOrder: 3 },
  { moduleKey: 'actionType', code: 'PAY_FEE', label: '缴纳官费', color: null, statisticsCode: null, sortOrder: 4 },
  { moduleKey: 'actionType', code: 'RECEIVE_DOC', label: '接收官文', color: null, statisticsCode: null, sortOrder: 5 },
  { moduleKey: 'actionType', code: 'OTHER', label: '其他', color: null, statisticsCode: null, sortOrder: 6 },
];

const rolePermissionDefinitions: Record<string, { codes: string[]; dataScope: 'ALL' | 'DEPARTMENT' | 'DEPARTMENT_AND_DESCENDANTS' | 'SELF' | 'RELATED' }> = {
  GENERAL_MANAGER: { codes: permissions.map(([code]) => code).filter((code) => code !== 'system.admin.access'), dataScope: 'ALL' },
  SALES: {
    codes: ['customer.read', 'customer.manage', 'customer.delete', 'customer.export', 'contract.read', 'contract.manage', 'contract.delete', 'contract.export', 'project.read', 'project.manage', 'project.delete', 'project.export', 'project.transition', 'attachment.read', 'attachment.download', 'attachment.upload', 'attachment.delete',
      // 提醒（2026-10-14）：销售在「提醒」里只看得到自己名下的项目/合同（SELF），
      // 不再与管理员的全局视角一模一样。不给 handle：提醒由"办完事的人"标记，
      // 销售是商务角色，避免误把别人的待办标掉。
      'reminder.read',
      // 销售作为项目负责人要能看到进度相关的附属数据，但不负责录入
      'official_document.read', 'mail_delivery.read', 'action_record.read', 'filing_result.read'],
    dataScope: 'SELF',
  },
  // 以下角色在流程里担任节点负责人（见 workflowTemplateDefinitions 的 assigneeRole），
  // 因此必须持有 project.transition，否则"节点由谁负责"形同虚设——他们连推进按钮都用不了。
  // 真正的约束在 NodeAssigneeService：只有**当前节点**的负责人能推进，
  // 所以这里的范围按"能看见自己参与的项目"来配（RELATED），而不是放宽到全库。
  // 代理人：官文、动作记录、申报结果的主要录入方
  PATENT_AGENT: { codes: ['customer.read', 'contract.read', 'project.read', 'project.manage', 'project.transition', 'attachment.read', 'attachment.download', 'attachment.upload',
    // 提醒（2026-10-14）：节点负责人在「提醒」里只看得到与自己相关的项目，并能把自己办完的标记为已处理
    'reminder.read', 'reminder.handle',
    'official_document.read', 'official_document.manage', 'official_document.delete',
    'mail_delivery.read', 'mail_delivery.manage',
    'action_record.read', 'action_record.manage', 'action_record.delete',
    'filing_result.read', 'filing_result.manage', 'filing_result.delete'], dataScope: 'RELATED' },
  TRADEMARK_AGENT: { codes: ['customer.read', 'contract.read', 'project.read', 'project.manage', 'project.transition', 'attachment.read', 'attachment.download', 'attachment.upload',
    'reminder.read', 'reminder.handle',
    'official_document.read', 'official_document.manage', 'official_document.delete',
    'mail_delivery.read', 'mail_delivery.manage',
    'action_record.read', 'action_record.manage', 'action_record.delete',
    'filing_result.read', 'filing_result.manage', 'filing_result.delete'], dataScope: 'RELATED' },
  // 流程人员：官文送达与邮件登记的主要操作方
  PROCESS_STAFF: { codes: ['customer.read', 'contract.read', 'contract.manage', 'project.read', 'project.manage', 'project.transition', 'payment.manage', 'attachment.read', 'attachment.download', 'attachment.upload',
    'reminder.read', 'reminder.handle',
    'official_document.read', 'official_document.manage', 'official_document.delete',
    'mail_delivery.read', 'mail_delivery.manage', 'mail_delivery.delete',
    'action_record.read', 'action_record.manage', 'action_record.delete',
    'filing_result.read', 'filing_result.manage'], dataScope: 'RELATED' },
  // 申报复核人：负责申报结果的记录
  FILING_REVIEWER: { codes: ['customer.read', 'contract.read', 'project.read', 'project.manage', 'project.transition', 'attachment.read', 'attachment.download', 'attachment.upload',
    'reminder.read', 'reminder.handle',
    'official_document.read', 'mail_delivery.read',
    'action_record.read', 'action_record.manage',
    'filing_result.read', 'filing_result.manage', 'filing_result.delete'], dataScope: 'DEPARTMENT' },
  // 财务要能收款，所以合同/客户/项目都给了全量可见（dataScope: ALL）。
  // 注意：PRD 3.3 权限矩阵里财务对「项目」标的是 ❌，这里是**按业务需要有意放宽**：
  // 回款登记在项目上进行，看不到项目就无法登记回款（dev 库 2026-10-14 按用户要求调整）。
  // 提醒也给全量：财务关注的是"哪些合同的款该收了"，待回款提醒是合同级的。
  FINANCE: { codes: ['customer.read', 'contract.read', 'project.read', 'payment.manage', 'cost.read', 'cost.manage', 'cost.delete', 'cost.export', 'attachment.read', 'attachment.download',
    'reminder.read', 'reminder.handle',
    'official_document.read'], dataScope: 'ALL' },
};

/**
 * 流程模板种子（PRD 第九章 + 用户 2026-10-10 要求的通用节点）。
 *
 * 建模约定：模板表定义「流程长什么样」，Project.workflowVersionId 记录「某个项目走哪个版本」。
 * 系统 B 修改流程 = 新建版本；这里预置的版本会直接发布（PUBLISHED），新项目据此绑定。
 *
 * assigneeType 用 ROLE + assigneeId 存角色编码：节点负责人按角色解析，人员变动不用改流程。
 * settings.statisticsCode 是该节点对应的「统计状态」，项目推进到该节点时状态自动同步
 *（PRD 5.5 的「状态映射统计状态」），避免出现"节点在审查、状态还是待完成"。
 */
type WorkflowNodeSeed = {
  sequence: number;
  code: string;
  name: string;
  assigneeRole?: string;
  deadlineDays?: number;
  warningDays?: number;
  statisticsCode: string;
};

type WorkflowTemplateSeed = {
  /** 与项目类型（projectType）对齐，用于按项目类型匹配模板 */
  name: string;
  description: string;
  nodes: WorkflowNodeSeed[];
};

const workflowTemplates: WorkflowTemplateSeed[] = [
  {
    name: '专利',
    description: 'PRD 9.1 专利流程模板：提交申请 → 受理 → 审查 → 授权 → 下证',
    nodes: [
      { sequence: 1, code: 'SUBMIT_APPLICATION', name: '提交申请', assigneeRole: 'PATENT_AGENT', deadlineDays: 3, warningDays: 1, statisticsCode: 'IN_PROGRESS' },
      { sequence: 2, code: 'ACCEPTANCE', name: '受理', assigneeRole: 'PROCESS_STAFF', deadlineDays: 15, warningDays: 3, statisticsCode: 'IN_PROGRESS' },
      { sequence: 3, code: 'EXAMINATION', name: '审查', assigneeRole: 'PATENT_AGENT', statisticsCode: 'IN_PROGRESS' },
      { sequence: 4, code: 'GRANT', name: '授权', assigneeRole: 'PROCESS_STAFF', statisticsCode: 'IN_PROGRESS' },
      { sequence: 5, code: 'CERTIFICATE', name: '下证', assigneeRole: 'PROCESS_STAFF', statisticsCode: 'COMPLETED' },
    ],
  },
  {
    name: '商标',
    description: 'PRD 9.2 商标流程模板：提交申请 → 受理 → 公告 → 注册 → 下证',
    nodes: [
      { sequence: 1, code: 'SUBMIT_APPLICATION', name: '提交申请', assigneeRole: 'TRADEMARK_AGENT', deadlineDays: 3, warningDays: 1, statisticsCode: 'IN_PROGRESS' },
      { sequence: 2, code: 'ACCEPTANCE', name: '受理', assigneeRole: 'PROCESS_STAFF', deadlineDays: 30, warningDays: 5, statisticsCode: 'IN_PROGRESS' },
      { sequence: 3, code: 'ANNOUNCEMENT', name: '公告', assigneeRole: 'PROCESS_STAFF', statisticsCode: 'IN_PROGRESS' },
      { sequence: 4, code: 'REGISTRATION', name: '注册', assigneeRole: 'PROCESS_STAFF', statisticsCode: 'IN_PROGRESS' },
      { sequence: 5, code: 'CERTIFICATE', name: '下证', assigneeRole: 'PROCESS_STAFF', statisticsCode: 'COMPLETED' },
    ],
  },
  {
    name: '软著',
    description: 'PRD 9.3 软著流程模板：提交申请 → 受理 → 审查 → 登记 → 下证',
    nodes: [
      { sequence: 1, code: 'SUBMIT_APPLICATION', name: '提交申请', assigneeRole: 'PROCESS_STAFF', deadlineDays: 3, warningDays: 1, statisticsCode: 'IN_PROGRESS' },
      { sequence: 2, code: 'ACCEPTANCE', name: '受理', assigneeRole: 'PROCESS_STAFF', deadlineDays: 15, warningDays: 3, statisticsCode: 'IN_PROGRESS' },
      { sequence: 3, code: 'EXAMINATION', name: '审查', assigneeRole: 'PROCESS_STAFF', statisticsCode: 'IN_PROGRESS' },
      { sequence: 4, code: 'REGISTRATION', name: '登记', assigneeRole: 'PROCESS_STAFF', statisticsCode: 'IN_PROGRESS' },
      { sequence: 5, code: 'CERTIFICATE', name: '下证', assigneeRole: 'PROCESS_STAFF', statisticsCode: 'COMPLETED' },
    ],
  },
  {
    name: '项目',
    description: 'PRD 9.4 项目申报流程模板：材料搜集 → 整理撰写 → 申报 → 结果',
    nodes: [
      { sequence: 1, code: 'MATERIAL_COLLECTION', name: '材料搜集', assigneeRole: 'PROCESS_STAFF', deadlineDays: 5, warningDays: 2, statisticsCode: 'IN_PROGRESS' },
      { sequence: 2, code: 'DRAFTING', name: '整理撰写', assigneeRole: 'PROCESS_STAFF', statisticsCode: 'IN_PROGRESS' },
      { sequence: 3, code: 'FILING', name: '申报', assigneeRole: 'PROCESS_STAFF', statisticsCode: 'IN_PROGRESS' },
      { sequence: 4, code: 'RESULT', name: '结果', assigneeRole: 'PROCESS_STAFF', statisticsCode: 'COMPLETED' },
    ],
  },
  {
    name: '通用流程',
    description: '通用流程节点（待分配 → 材料准备 → 内部审核 → 对外申报 → 官方受理 → 补正 → 完成 → 异常关闭），项目类型未匹配到专用模板时使用',
    nodes: [
      { sequence: 1, code: 'TO_BE_ASSIGNED', name: '待分配', assigneeRole: 'PROCESS_STAFF', statisticsCode: 'PENDING' },
      { sequence: 2, code: 'MATERIAL_PREP', name: '材料准备', assigneeRole: 'PROCESS_STAFF', deadlineDays: 5, warningDays: 2, statisticsCode: 'IN_PROGRESS' },
      { sequence: 3, code: 'INTERNAL_REVIEW', name: '内部审核', assigneeRole: 'FILING_REVIEWER', deadlineDays: 3, warningDays: 1, statisticsCode: 'IN_PROGRESS' },
      { sequence: 4, code: 'EXTERNAL_FILING', name: '对外申报', assigneeRole: 'PROCESS_STAFF', statisticsCode: 'IN_PROGRESS' },
      { sequence: 5, code: 'OFFICIAL_ACCEPTANCE', name: '官方受理', assigneeRole: 'PROCESS_STAFF', statisticsCode: 'IN_PROGRESS' },
      { sequence: 6, code: 'SUPPLEMENT', name: '补正', assigneeRole: 'PROCESS_STAFF', deadlineDays: 10, warningDays: 3, statisticsCode: 'IN_PROGRESS' },
      { sequence: 7, code: 'COMPLETED', name: '完成', assigneeRole: 'PROCESS_STAFF', statisticsCode: 'COMPLETED' },
      { sequence: 8, code: 'EXCEPTION_CLOSED', name: '异常关闭', assigneeRole: 'PROCESS_STAFF', statisticsCode: 'EXCEPTION' },
    ],
  },
];

async function seedWorkflowTemplates() {
  let templateCount = 0;
  let nodeCount = 0;

  for (const template of workflowTemplates) {
    const existing = await prisma.workflowTemplate.findFirst({
      where: { moduleKey: 'project', name: template.name },
      select: { id: true },
    });
    const record = existing
      ? await prisma.workflowTemplate.update({
          where: { id: existing.id },
          // isSystem: true —— 种子预置的模板不允许在「管理系统 → 流程管理」里删除，
          // 因为项目按「项目类型」匹配同名模板，其中「通用流程」还是代码里的兜底模板。
          data: { description: template.description, isActive: true, isSystem: true },
          select: { id: true },
        })
      : await prisma.workflowTemplate.create({
          data: { moduleKey: 'project', name: template.name, description: template.description, isSystem: true },
          select: { id: true },
        });
    templateCount += 1;

    // 预置版本：不存在则建 v1 并直接发布，保证新项目有流程可绑定
    let version = await prisma.workflowVersion.findFirst({
      where: { templateId: record.id },
      orderBy: { version: 'desc' },
    });
    if (!version) {
      version = await prisma.workflowVersion.create({
        data: { templateId: record.id, version: 1, status: 'PUBLISHED', publishedAt: new Date() },
      });
    }

    for (const node of template.nodes) {
      await prisma.workflowNode.upsert({
        where: { versionId_code: { versionId: version.id, code: node.code } },
        update: {
          name: node.name,
          sequence: node.sequence,
          assigneeType: 'ROLE',
          assigneeId: node.assigneeRole ?? null,
          deadlineDays: node.deadlineDays ?? null,
          warningDays: node.warningDays ?? null,
          settings: { statisticsCode: node.statisticsCode },
        },
        create: {
          versionId: version.id,
          code: node.code,
          name: node.name,
          nodeType: 'MANUAL',
          sequence: node.sequence,
          assigneeType: 'ROLE',
          assigneeId: node.assigneeRole ?? null,
          deadlineDays: node.deadlineDays ?? null,
          warningDays: node.warningDays ?? null,
          settings: { statisticsCode: node.statisticsCode },
        },
      });
      nodeCount += 1;
    }
  }

  return { templateCount, nodeCount };
}

/**
 * 把每个模块的排序号压缩成 1、2、3…（按现有顺序），供「模块字段」与「选项配置」使用。
 *
 * ## 为什么不能只改上面的常量
 *
 * 上面的 upsert 只覆盖**种子里登记过**的行。两类行的排序号它管不到：
 *
 * 1. **管理员在界面上自建的字段/选项** —— 例如动作记录上那个已停用的「承办人」。
 *    它们不在种子里，sortOrder 是创建时写的；而旧代码创建时默认写 **0**，
 *    于是它们永远排在最前面。
 * 2. **已经跑起来的库** —— 开发库、以及将来升级的生产库里存的是旧的 10/20/30，
 *    需要一个"迁移式"的重排才能变成 1、2、3。
 *
 * ## 为什么在种子里做，而不是写一条数据迁移
 *
 * 种子本身就是这个项目的"配置基线"载体（角色、权限、字段、状态都在这里），
 * 而排序号属于**展示配置**，不是业务数据。放在种子里还能自愈：
 * 以后不管谁把排序号改成什么，下一次播种都会重新压平。
 *
 * ## 只压缩数字，不改相对顺序
 *
 * 排序键与列表接口一致（sortOrder → createdAt → id），所以结果与界面上看到的
 * 先后关系完全相同，人工调整过的顺序会被保留，只是数字变连续。
 */
async function normalizeSortOrders() {
  // FieldDefinition 与 StatusDefinition 的表名与列名在 Prisma 里都是同名映射（无 @map），
  // 因此可以直接拼表名；表名来自下面的常量数组，不含外部输入。
  for (const table of ['FieldDefinition', 'StatusDefinition'] as const) {
    await prisma.$executeRawUnsafe(`
      WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY "moduleKey"
                 ORDER BY "sortOrder" ASC, "createdAt" ASC, id ASC
               ) AS rn
        FROM "${table}"
      )
      UPDATE "${table}" AS t
      SET "sortOrder" = r.rn
      FROM ranked AS r
      WHERE t.id = r.id
    `);
  }
}

async function main() {
  const initialPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!initialPassword) {
    throw new Error('SEED_ADMIN_PASSWORD is required to initialize the admin account');
  }

  const rootDepartment = await prisma.department.upsert({
    where: { code: 'ROOT' },
    update: { name: '总公司', isActive: true },
    create: { code: 'ROOT', name: '总公司' },
  });

  const roleRecords = new Map<string, { id: string }>();
  for (const role of roles) {
    const record = await prisma.role.upsert({
      where: { code: role.code },
      update: { name: role.name, isSystem: role.isSystem, isActive: true },
      create: role,
      select: { id: true },
    });
    roleRecords.set(role.code, record);
  }

  const permissionRecords = [] as Array<{ id: string; code: string }>;
  const permissionRecordsByCode = new Map<string, { id: string; code: string }>();
  for (const [code, name, kind, resource, action] of permissions) {
    const record = await prisma.permission.upsert({
      where: { code },
      update: { name, kind, resource, action },
      create: { code, name, kind, resource, action },
      select: { id: true, code: true },
    });
    permissionRecords.push(record);
    permissionRecordsByCode.set(record.code, record);
  }

  for (const field of fieldDefinitions) {
    await prisma.fieldDefinition.upsert({
      where: { moduleKey_fieldKey: { moduleKey: field.moduleKey, fieldKey: field.fieldKey } },
      update: { label: field.label, fieldType: field.fieldType, isRequired: field.isRequired, isSystem: field.isSystem, isListVisible: field.isListVisible, isSearchable: field.isSearchable, sortOrder: field.sortOrder, isActive: true },
      create: field,
    });
  }

  for (const status of statusDefinitions) {
    await prisma.statusDefinition.upsert({
      where: { moduleKey_code: { moduleKey: status.moduleKey, code: status.code } },
      update: { label: status.label, color: status.color, statisticsCode: status.statisticsCode, sortOrder: status.sortOrder, isSystem: true, isActive: true },
      create: { ...status, isSystem: true },
    });
  }

  // 兜底归一化：把每个模块的排序号压平成 1、2、3…
  // 上面的循环只管种子里登记过的行，这里连同管理员自建的字段/选项一起重排。
  await normalizeSortOrders();

  const passwordHash = await bcrypt.hash(initialPassword, 12);
  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {
      displayName: '系统管理员',
      status: 'ACTIVE',
      isSystemAdmin: true,
      deletedAt: null,
    },
    create: {
      username: 'admin',
      passwordHash,
      displayName: '系统管理员',
      status: 'ACTIVE',
      isSystemAdmin: true,
    },
    select: { id: true },
  });

  await prisma.userDepartment.upsert({
    where: {
      userId_departmentId: {
        userId: admin.id,
        departmentId: rootDepartment.id,
      },
    },
    update: { isPrimary: true },
    create: {
      userId: admin.id,
      departmentId: rootDepartment.id,
      isPrimary: true,
    },
  });

  const adminRole = roleRecords.get('SYSTEM_ADMIN');
  if (!adminRole) throw new Error('SYSTEM_ADMIN role was not created');

  await prisma.userRole.upsert({
    where: {
      userId_roleId: {
        userId: admin.id,
        roleId: adminRole.id,
      },
    },
    update: {},
    create: { userId: admin.id, roleId: adminRole.id },
  });

  for (const permission of permissionRecords) {
    await prisma.rolePermission.upsert({
      where: {
        roleId_permissionId: {
          roleId: adminRole.id,
          permissionId: permission.id,
        },
      },
      update: { allowed: true, dataScope: 'ALL' },
      create: {
        roleId: adminRole.id,
        permissionId: permission.id,
        allowed: true,
        dataScope: 'ALL',
      },
    });
  }

  for (const [roleCode, definition] of Object.entries(rolePermissionDefinitions)) {
    const role = roleRecords.get(roleCode);
    if (!role) continue;
    for (const permissionCode of definition.codes) {
      const permission = permissionRecordsByCode.get(permissionCode);
      if (!permission) continue;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: { allowed: true, dataScope: definition.dataScope },
        create: { roleId: role.id, permissionId: permission.id, allowed: true, dataScope: definition.dataScope },
      });
    }
  }

  // 清理历史版本中拆分的回款权限。新权限已在上面的角色定义中完成授权，
  // 因此重复执行 seed 也会保持数据库与当前权限模型一致。
  await prisma.rolePermission.deleteMany({
    where: { permission: { code: { in: ['payment.read', 'payment.create', 'payment.update', 'payment.delete', 'payment.export'] } } },
  });
  await prisma.permission.deleteMany({
    where: { code: { in: ['payment.read', 'payment.create', 'payment.update', 'payment.delete', 'payment.export'] } },
  });

  await prisma.department.update({
    where: { id: rootDepartment.id },
    data: { managerId: admin.id },
  });

  const workflow = await seedWorkflowTemplates();

  console.log(
    `Seed complete: ${roles.length} roles, ${permissionRecords.length} permissions, ` +
      `${workflow.templateCount} workflow templates (${workflow.nodeCount} nodes), admin account initialized.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
