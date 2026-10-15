-- 修复：Contract.businessStartAt 字段在 schema 与代码中已使用，但缺少数据库迁移，
-- 导致所有合同查询报错 `The column Contract.businessStartAt does not exist`。
--
-- 该字段语义：业务起算日期，用于「系统算建议截止日」的起算点。
-- 说明：早期实现复用了 createdAt（合同录入时刻）；后续改为可由业务人员人工填写的独立字段。
-- 本次只补列，保证接口不再报错；最终语义以业务确认为准。

ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "businessStartAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Contract_businessStartAt_idx" ON "public"."Contract"("businessStartAt");

-- 存量合同回填：无值时用录入时间兜底，避免历史合同算建议截止日时没有起算点
UPDATE "public"."Contract"
SET "businessStartAt" = "createdAt"
WHERE "businessStartAt" IS NULL;
