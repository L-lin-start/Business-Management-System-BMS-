import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * 删除请求体（PRD 7.2）。
 *
 * > 删除时弹高危操作提示，必须勾选"我已知晓风险"。
 * > 必须填写删除原因，不允许为空。
 *
 * 字段说明：
 *   - `reason`：删除原因，**后端强制必填**（前端也校验，但后端才是真正的关口）
 *   - `confirmedRisk`：前端"我已知晓风险"勾选框的结果。
 *     后端只做记录/校验用途 —— 前端已保证必须勾选后才能提交，
 *     后端再校验一次是为了防止绕过界面直接调接口。
 */
export class DeleteReasonDto {
  @IsString({ message: '请填写删除原因' })
  @MinLength(1, { message: '请填写删除原因' })
  @MaxLength(200, { message: '删除原因不能超过 200 字' })
  reason!: string;

  @IsOptional()
  @IsString()
  confirmedRisk?: string;
}

/** 恢复请求体：恢复同样留痕，需要说明原因 */
export class RestoreReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
