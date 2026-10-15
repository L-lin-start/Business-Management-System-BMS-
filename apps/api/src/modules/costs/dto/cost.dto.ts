import { Type } from 'class-transformer';
import { IsDateString, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CostQueryDto {
  @IsOptional()
  @IsString()
  keyword?: string;

  /** 按合同筛选（合同详情内的成本区块使用） */
  @IsOptional()
  @IsString()
  contractId?: string;

  /** 按项目筛选（项目详情内的成本区块使用） */
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

/** 成本登记在项目上，合同归属由服务端按项目自动带出，前端不传。 */
export class CreateCostDto {
  @IsString()
  projectId!: string;

  @IsString()
  @MaxLength(100)
  costType!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsDateString()
  incurredAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateCostDto extends CreateCostDto {}
