-- 补齐合同类型的业务时限天数。
--
-- 背景：这些时限原先是直接在开发库里改的，没有进迁移文件，
-- 因此在全新数据库（如测试库、未来的生产库）上应用完所有迁移后，
-- 除「专利」外都退回全局默认 30 天，「系统算建议截止日」的业务类型差异就失效了。
--
-- 用 WHERE "timeLimitDays" IS NULL 兜底：不覆盖已经人工调整过的值（开发库里已配好的不受影响）。
-- 「其他」保持为空，表示使用全局默认时限（reminder.defaultTimeLimitDays）。

UPDATE "public"."StatusDefinition"
   SET "timeLimitDays" = 45,
       "timeLimitNote" = COALESCE(NULLIF("timeLimitNote", ''), '商标常规周期，按实际局方时限调整'),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "moduleKey" = 'contractType' AND "code" = 'TRADEMARK' AND "timeLimitDays" IS NULL;

UPDATE "public"."StatusDefinition"
   SET "timeLimitDays" = 15,
       "timeLimitNote" = COALESCE(NULLIF("timeLimitNote", ''), '软著常规周期，按实际局方时限调整'),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "moduleKey" = 'contractType' AND "code" = 'COPYRIGHT' AND "timeLimitDays" IS NULL;

UPDATE "public"."StatusDefinition"
   SET "timeLimitDays" = 30,
       "timeLimitNote" = COALESCE(NULLIF("timeLimitNote", ''), '项目申报按批次时限调整'),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "moduleKey" = 'contractType' AND "code" = 'PROJECT' AND "timeLimitDays" IS NULL;
