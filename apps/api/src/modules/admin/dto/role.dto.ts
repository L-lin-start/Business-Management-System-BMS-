import { IsArray, IsBoolean, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { DataScope } from '@prisma/client';

export class CreateRoleDto {
  @IsString()
  @MinLength(1)
  name!: string;

  /** 技术编码由后端自动生成，保留可选字段兼容旧客户端。 */
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class PermissionAssignmentDto {
  @IsString()
  permissionId!: string;

  @IsBoolean()
  allowed!: boolean;

  @IsEnum(DataScope)
  dataScope!: DataScope;
}

export class UpdateRolePermissionsDto {
  @IsArray()
  assignments!: PermissionAssignmentDto[];
}
