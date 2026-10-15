import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

const fieldTypes = ['TEXT', 'NUMBER', 'DATE', 'SELECT', 'MULTI_SELECT', 'BOOLEAN', 'ATTACHMENT', 'RELATION', 'USER'] as const;

export class FieldDefinitionQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/)
  moduleKey?: string;
}

export class CreateFieldDefinitionDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/)
  moduleKey!: string;

  /** 技术字段编码由后端自动生成，管理员只需要填写字段名称。 */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/)
  fieldKey?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  label!: string;

  @IsIn(fieldTypes)
  fieldType!: (typeof fieldTypes)[number];

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @IsBoolean()
  isListVisible?: boolean;

  @IsOptional()
  @IsBoolean()
  isSearchable?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class UpdateFieldDefinitionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  label?: string;

  @IsOptional()
  @IsIn(fieldTypes)
  fieldType?: (typeof fieldTypes)[number];

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @IsBoolean()
  isListVisible?: boolean;

  @IsOptional()
  @IsBoolean()
  isSearchable?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}
