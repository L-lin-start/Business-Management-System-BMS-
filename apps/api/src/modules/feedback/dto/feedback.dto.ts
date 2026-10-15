import { IsArray, IsIn, IsOptional, IsString, ArrayUnique, MaxLength, MinLength } from 'class-validator';

export const FEEDBACK_STATUS_CODES = ['PENDING', 'PROCESSING', 'RESOLVED', 'CLOSED'] as const;
export const FEEDBACK_PRIORITY_CODES = ['LOW', 'NORMAL', 'HIGH'] as const;

export class CreateFeedbackDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  content!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @IsOptional()
  @IsIn(FEEDBACK_PRIORITY_CODES)
  priority?: (typeof FEEDBACK_PRIORITY_CODES)[number];
}

export class UpdateFeedbackDto {
  @IsIn(FEEDBACK_STATUS_CODES)
  statusCode!: (typeof FEEDBACK_STATUS_CODES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  handlingNote?: string;
}

export class UpdateFeedbackRoutingDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  departmentIds!: string[];
}
