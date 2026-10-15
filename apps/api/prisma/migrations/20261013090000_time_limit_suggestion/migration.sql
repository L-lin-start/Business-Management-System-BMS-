-- 阶段 3.2：系统算建议截止日（PRD 4.7「系统算建议截止日，人工复核确认」）
--
-- 设计：
--   建议法定截止日 = 签约日 + 该业务类型的时限天数
--   约束：不得晚于合同到期日（合同到期即结束，建议值再晚就没有意义）
--   建议内部安全日 = 建议法定截止日 - 内部安全日提前天数（复用 reminder.safetyMarginDays）
--   系统只给建议值，填进表单后人工可改，以人工确认为准（PRD 明确要求人工复核确认）
--
-- 时限天数按业务类型配置（专利/商标/软著各不同），另设一个全局默认值兜底。
-- 放在 StatusDefinition 上而不是新建表：这两者都是「业务类型的属性」，跟着选项一起维护更自然。

ALTER TABLE "public"."StatusDefinition" ADD COLUMN IF NOT EXISTS "timeLimitDays" INTEGER;
ALTER TABLE "public"."StatusDefinition" ADD COLUMN IF NOT EXISTS "timeLimitNote" TEXT;

-- 全局默认时限（业务类型未单独配置时使用）
INSERT INTO "public"."SystemConfig" ("key", "value", "valueType", "label", "updatedAt") VALUES
  ('reminder.defaultTimeLimitDays', '30', 'NUMBER', '默认业务时限天数（业务类型未单独配置时使用）', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- 给预置合同类型填上常见的时限天数（仅为初始建议值，可在选项配置中随时改）
UPDATE "public"."StatusDefinition" SET "timeLimitDays" = 30, "timeLimitNote" = '发明专利常规周期，按实际局方时限调整'
  WHERE "moduleKey" = 'contractType' AND "code" = 'PATENT';
UPDATE "public"."StatusDefinition" SET "timeLimitDays" = 45, "timeLimitNote" = '商标常规周期，按实际局方时限调整'
  WHERE "moduleKey" = 'contractType' AND "code" = 'TRADEMARK';
UPDATE "public"."StatusDefinition" SET "timeLimitDays" = 15, "timeLimitNote" = '软著常规周期，按实际局方时限调整'
  WHERE "moduleKey" = 'contractType' AND "code" = 'COPYRIGHT';
UPDATE "public"."StatusDefinition" SET "timeLimitDays" = 30, "timeLimitNote" = '项目申报按批次时限调整'
  WHERE "moduleKey" = 'contractType' AND "code" = 'PROJECT';
