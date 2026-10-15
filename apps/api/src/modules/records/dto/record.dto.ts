import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEmail, IsInt, IsObject, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

/** 四类附属业务数据的 DTO（官文 / 邮件送达 / 动作记录 / 申报结果） */

/* ---------------------------- 官文 ---------------------------- */

export class CreateOfficialDocumentDto {
  @IsString()
  @MinLength(1)
  projectId!: string;

  /** 官文类型（受控选项编码，系统 B 可配） */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  documentType?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  documentName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  issuingAuthority?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  documentNo?: string;

  @IsOptional()
  @IsDateString()
  issuedAt?: string;

  /** 送达日：PRD 4.5「自动生成时限节点」的起算点 */
  @IsOptional()
  @IsDateString()
  deliveredAt?: string;

  /** 来源（受控选项编码） */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  source?: string;

  @IsOptional()
  @IsBoolean()
  needsMailDelivery?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class UpdateOfficialDocumentDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  documentType?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  documentName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  issuingAuthority?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  documentNo?: string;

  @IsOptional()
  @IsDateString()
  issuedAt?: string;

  @IsOptional()
  @IsDateString()
  deliveredAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  source?: string;

  @IsOptional()
  @IsBoolean()
  needsMailDelivery?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class OfficialDocumentQueryDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  documentType?: string;

  @IsOptional()
  @IsString()
  keyword?: string;

  /** 只看还需要邮件送达、但尚未登记送达的官文（PRD 4.6 超时登记提醒的数据来源） */
  @IsOptional()
  @IsString()
  needsMailOnly?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

/* -------------------------- 邮件送达登记 -------------------------- */

export class CreateMailDeliveryDto {
  @IsString()
  @MinLength(1)
  officialDocumentId!: string;

  @IsString()
  @IsEmail()
  @MinLength(1)
  @MaxLength(200)
  recipientEmail!: string;

  /** 实际发送日期；为空表示尚未发送 */
  @IsOptional()
  @IsDateString()
  sentAt?: string;

  @IsOptional()
  @IsString()
  sentById?: string;

  /** 状态（受控选项编码，默认待发送） */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  statusCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class UpdateMailDeliveryDto {
  @IsOptional()
  @IsEmail()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  recipientEmail?: string;

  @IsOptional()
  @IsDateString()
  sentAt?: string;

  @IsOptional()
  @IsString()
  sentById?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  statusCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class MailDeliveryQueryDto {
  @IsOptional()
  @IsString()
  officialDocumentId?: string;

  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  statusCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

/* ---------------------------- 动作记录 ---------------------------- */

export class CreateActionRecordDto {
  @IsString()
  @MinLength(1)
  projectId!: string;

  /** 动作类型（受控选项编码，系统 B 可配；PRD 4.8「动作类型可自定义」） */
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  actionType!: string;

  /** 实际日期（PRD 4.8「必录实际日期」） */
  @IsDateString()
  actionAt!: string;

  @IsOptional()
  @IsString()
  operatorId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class UpdateActionRecordDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  actionType?: string;

  @IsOptional()
  @IsDateString()
  actionAt?: string;

  @IsOptional()
  @IsString()
  operatorId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class ActionRecordQueryDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  actionType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

/* --------------------------- 申报结果记录 --------------------------- */

export class CreateFilingResultDto {
  @IsString()
  @MinLength(1)
  projectId!: string;

  /** 结果状态（受控选项编码：通过 / 不通过 / 待重做） */
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  resultCode!: string;

  @IsDateString()
  recordedAt!: string;

  @IsOptional()
  @IsString()
  recordedById?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class UpdateFilingResultDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  resultCode?: string;

  @IsOptional()
  @IsDateString()
  recordedAt?: string;

  @IsOptional()
  @IsString()
  recordedById?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class FilingResultQueryDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  resultCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

/** 供 delete 接口携带删除原因（PRD 第七章要求删除原因必填） */
export class RemoveRecordDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
