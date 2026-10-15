import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsInt, IsNumber, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class ContractQueryDto {
  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @IsString()
  statusCode?: string;

  @IsOptional()
  @IsString()
  customerId?: string;

  /**
   * 只筛/只导出某一张合同。
   *
   * 用于 PRD 4.12「合同详情页导出本合同」—— 详情页导出应当只含这一张合同。
   * 列表查询本身不使用该字段，因此不影响既有行为。
   */
  @IsOptional()
  @IsString()
  contractId?: string;

  @IsOptional()
  @Type(() => Number)
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(100)
  pageSize = 20;
}

export class CreateContractDto {
  /**
   * 合同编号由业务人员按实际合同填写（不再自动生成）。
   * 约束：非空、不含空白字符（空格/制表/换行）、不超过 50 字；重号由服务端拒绝。
   * 项目编号按「合同编号-序号」派生，故编号里不能有空格。
   */
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^\S+$/, { message: '合同编号不能包含空格、制表符或换行' })
  contractNo!: string;

  @IsString()
  @MinLength(1)
  customerId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  contractType?: string;

  /** 产品（PRD 8.2 必填） */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  product?: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount!: number;

  /** 单价（PRD 8.2）；填写后与「单价 × 件数」互相校验 */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitPrice?: number;

  /** 付款方式：全款 / 分期 / 按进度（选项编码） */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  paymentTerm?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;

  /** 公司名称：留空时取客户名称（PRD 8.2 与客户名称同源） */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  companyName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  contactEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  companyAddress?: string;

  /** 件数：决定自动生成几个项目，缺省 1。 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  itemCount?: number;

  /** 是否在创建合同时按件数自动生成项目，缺省 true。 */
  @IsOptional()
  @IsBoolean()
  autoGenerateProjects?: boolean;

  @IsOptional()
  @IsDateString()
  signedAt?: string;

  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  /** 业务起算日期：由人工填写；系统根据此日期计算建议截止日 */
  @IsOptional()
  @IsDateString()
  businessStartAt?: string;

  /** 法定截止日：官方/客户要求的最后期限，提醒中心据此倒推内部安全日 */
  @IsOptional()
  @IsDateString()
  legallyDueAt?: string;

  /** 内部安全日：内部要求的完成日；不填则按「法定截止日 - 安全天数配置」推算 */
  @IsOptional()
  @IsDateString()
  internalSafetyDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  statusCode?: string;

  @IsOptional()
  @IsString()
  ownerId?: string;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class UpdateContractDto {
  /** 客户端读到的版本号，用于乐观锁；不一致说明他人已修改，返回 409 */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;

  /**
   * 合同编号（人工填写）。修改时其下所有项目的编号会**自动跟着改**（保持「合同编号-序号」一致）。
   * 编辑表单目前不开放该字段，接口保留该能力供后续或脚本使用。
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^\S+$/, { message: '合同编号不能包含空格、制表符或换行' })
  contractNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  contractType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  product?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitPrice?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  paymentTerm?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  companyName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  contactEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  companyAddress?: string;

  /** 件数：只登记数值，不会自动增删已生成的项目（如需增减请在项目页手工维护）。 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  itemCount?: number;

  @IsOptional()
  @IsDateString()
  signedAt?: string;

  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  /** 业务起算日期：由人工填写；修改历史合同也可修正此日期 */
  @IsOptional()
  @IsDateString()
  businessStartAt?: string;

  /** 法定截止日：官方/客户要求的最后期限，提醒中心据此倒推内部安全日 */
  @IsOptional()
  @IsDateString()
  legallyDueAt?: string;

  /** 内部安全日：内部要求的完成日；不填则按「法定截止日 - 安全天数配置」推算 */
  @IsOptional()
  @IsDateString()
  internalSafetyDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  statusCode?: string;

  /** 状态变化原因，写入状态变化历史（改状态时建议填写） */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  statusReason?: string;

  @IsOptional()
  @IsString()
  ownerId?: string;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

/**
 * 合同终止（PRD 4.2 要求记录 5 个要素）。
 * 未完成项目处理为「项目一并终止」时，会把其下未完成项目置为已终止。
 */
export class TerminateContractDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;

  /** 终止日期 */
  @IsDateString()
  terminatedAt!: string;

  /** 终止类型（选项编码：CUSTOMER_REQUEST / REFUND / TRANSFER_BUSINESS / REJECTED / OTHER） */
  @IsString()
  @MaxLength(50)
  terminationType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  terminationReason!: string;

  /** 未完成项目的处理方式（选项编码） */
  @IsString()
  @MaxLength(50)
  unfinishedProjectAction!: string;

  /** 未回款的处理方式（选项编码） */
  @IsString()
  @MaxLength(50)
  unpaidAmountAction!: string;
}

/** 合同金额调整（退款 / 折扣 / 坏账 / 部分豁免） */
export class CreateContractAdjustmentDto {
  /** 调整类型（选项编码：REFUND / DISCOUNT / BAD_DEBT / WAIVER / OTHER） */
  @IsString()
  @MaxLength(50)
  adjustType!: string;

  /** 调整金额（正数，表示减少应收） */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsDateString()
  occurredAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

