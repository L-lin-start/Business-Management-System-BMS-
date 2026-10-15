import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsDateString, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';

/** 回款在项目上的分摊。一笔回款可跨合同、跨项目拆分。 */
export class PaymentProjectAllocationDto {
  @IsString()
  projectId!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;
}

/** 回款在合同上的分配。一笔回款可对应多个合同。 */
export class PaymentContractAllocationDto {
  @IsString()
  contractId!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;
}

export class PaymentQueryDto {
  @IsOptional()
  @IsString()
  keyword?: string;

  /** 按合同筛选（合同详情内的回款区块使用） */
  @IsOptional()
  @IsString()
  contractId?: string;

  /** 按项目筛选（项目详情内的回款区块使用） */
  @IsOptional()
  @IsString()
  projectId?: string;

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

export class CreatePaymentDto {
  /** 兼容旧客户端：单合同回款时可直接传入。跨合同回款请使用 contractAllocations。 */
  @IsOptional()
  @IsString()
  contractId?: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsDateString()
  receivedAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  paymentMethod?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PaymentProjectAllocationDto)
  allocations!: PaymentProjectAllocationDto[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PaymentContractAllocationDto)
  contractAllocations?: PaymentContractAllocationDto[];

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;

  /**
   * 超额收款确认标记（业务确认 2026-10-14：允许超收，但必须二次确认）。
   *
   * 提交回款时若「已收款 + 本次」超过合同应收净额，后端返回 409 与
   * `OVERPAY_CONFIRMATION_REQUIRED`；前端弹确认框，用户确认后带本标记重新提交即可放行。
   */
  @IsOptional()
  @IsBoolean()
  confirmOverpay?: boolean;
}

export class UpdatePaymentDto extends CreatePaymentDto {}
