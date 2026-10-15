-- 阶段 2：提醒中心
--
-- 1) 合同补两个日期字段：法定截止日、内部安全日（PRD 8.2，提醒中心据此倒推倒计时）
-- 2) 新增 SystemConfig（提醒参数配置）、Reminder（提醒记录，可标记已处理）
-- 3) 新增权限点 reminder.read / reminder.handle
--
-- Reminder.dedupeKey 唯一索引是幂等扫描的关键：同一对象+同一提醒类型+同一到期日只有一条，
-- 反复扫描不会产生重复提醒。

ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "legallyDueAt" TIMESTAMP(3);
ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "internalSafetyDate" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Contract_legallyDueAt_idx" ON "public"."Contract"("legallyDueAt");
CREATE INDEX IF NOT EXISTS "Contract_internalSafetyDate_idx" ON "public"."Contract"("internalSafetyDate");

DO $$ BEGIN
  CREATE TYPE "public"."ReminderType" AS ENUM ('CONTRACT_DEADLINE', 'INTERNAL_SAFETY', 'NODE_OVERDUE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "public"."SystemConfig" (
  "key"       TEXT NOT NULL,
  "value"     TEXT NOT NULL,
  "valueType" TEXT NOT NULL DEFAULT 'NUMBER',
  "label"     TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("key")
);

CREATE TABLE IF NOT EXISTS "public"."Reminder" (
  "id"             TEXT NOT NULL,
  "type"           "public"."ReminderType" NOT NULL,
  "sourceType"     TEXT NOT NULL,
  "sourceId"       TEXT NOT NULL,
  "sourceNo"       TEXT,
  "title"          TEXT NOT NULL,
  "detail"         TEXT,
  "triggerAt"      TIMESTAMP(3) NOT NULL,
  "dueAt"          TIMESTAMP(3) NOT NULL,
  "overdueDays"    INTEGER NOT NULL DEFAULT 0,
  "dedupeKey"      TEXT NOT NULL,
  "isHandled"      BOOLEAN NOT NULL DEFAULT false,
  "handledAt"      TIMESTAMP(3),
  "handledById"    TEXT,
  "handleNote"     TEXT,
  "isSourceClosed" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Reminder_dedupeKey_key" ON "public"."Reminder"("dedupeKey");
CREATE INDEX IF NOT EXISTS "Reminder_isHandled_triggerAt_idx" ON "public"."Reminder"("isHandled", "triggerAt");
CREATE INDEX IF NOT EXISTS "Reminder_type_isHandled_idx" ON "public"."Reminder"("type", "isHandled");
CREATE INDEX IF NOT EXISTS "Reminder_sourceType_sourceId_idx" ON "public"."Reminder"("sourceType", "sourceId");
CREATE INDEX IF NOT EXISTS "Reminder_dueAt_idx" ON "public"."Reminder"("dueAt");

-- 提醒参数默认值（管理员可在系统 B 调整）
INSERT INTO "public"."SystemConfig" ("key", "value", "valueType", "label", "updatedAt") VALUES
  ('reminder.contractAdvanceDays', '30', 'NUMBER', '合同到期提前提醒天数', CURRENT_TIMESTAMP),
  ('reminder.nodeAdvanceDays',     '3',  'NUMBER', '流程节点提前提醒天数', CURRENT_TIMESTAMP),
  ('reminder.safetyMarginDays',    '7',  'NUMBER', '内部安全日提前于法定截止日的天数', CURRENT_TIMESTAMP),
  ('reminder.retentionDays',       '7',  'NUMBER', '已处理提醒保留天数', CURRENT_TIMESTAMP),
  ('reminder.scanIntervalMinutes', '60', 'NUMBER', '自动扫描间隔（分钟，0 表示不自动扫描）', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- 提醒查看与处理分开授权：能看提醒不等于能销掉提醒
INSERT INTO "public"."Permission" ("id", "code", "name", "kind", "resource", "action", "createdAt", "updatedAt") VALUES
  (gen_random_uuid()::TEXT, 'reminder.read',   '查看提醒',   'FUNCTION',  'reminder', 'read',   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'reminder.handle', '处理提醒',   'OPERATION', 'reminder', 'handle', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "public"."RolePermission" ("roleId", "permissionId", "allowed", "dataScope")
SELECT r."id", p."id", true, 'ALL'
FROM "public"."Role" r, "public"."Permission" p
WHERE r."code" = 'SYSTEM_ADMIN' AND p."code" IN ('reminder.read', 'reminder.handle')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
