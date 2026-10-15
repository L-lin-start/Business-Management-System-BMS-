import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const nodeTypes = ['MANUAL', 'AUTOMATIC', 'PARALLEL', 'CONDITION'] as const;
const assigneeTypes = ['USER', 'ROLE', 'DEPARTMENT_MANAGER'] as const;

export class CreateWorkflowTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  moduleKey = 'project';

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;
}

export class UpdateWorkflowTemplateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateWorkflowVersionDto {
  /** 从该版本复制节点，便于在老流程基础上改出新版本（PRD 4.4：不在老流程上直接插入节点） */
  @IsOptional()
  @IsString()
  copyFromVersionId?: string;
}

export class WorkflowNodeDto {
  /** 节点技术编码由后端自动生成；编辑时保留原编码以保证历史流程稳定。 */
  @IsOptional()
  @IsString()
  code?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsIn(nodeTypes)
  nodeType: (typeof nodeTypes)[number] = 'MANUAL';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(999)
  sequence!: number;

  @IsOptional()
  @IsIn(assigneeTypes)
  assigneeType?: (typeof assigneeTypes)[number];

  /** 负责人：assigneeType 为 ROLE 时存角色编码，为 USER 时存用户 ID */
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  deadlineDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  warningDays?: number;

  /** 该节点对应的统计状态编码，推进到该节点时项目状态自动同步 */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  statisticsCode?: string;

  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}
