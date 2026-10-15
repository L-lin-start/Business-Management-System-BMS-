import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ProjectQueryDto {
  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @IsString()
  statusCode?: string;

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

export class CreateProjectDto {
  @IsString()
  contractId!: string;

  @IsString()
  @MaxLength(200)
  projectName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  projectType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  statusCode?: string;

  @IsOptional()
  @IsString()
  ownerId?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class UpdateProjectDto {
  /** 客户端读到的版本号，用于乐观锁；不一致说明他人已修改，返回 409 */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  projectName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  projectType?: string;

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
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}
