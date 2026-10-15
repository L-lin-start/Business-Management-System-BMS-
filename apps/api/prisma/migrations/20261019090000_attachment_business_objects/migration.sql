-- 合同/项目的附属业务数据建模（PRD 2.2「固定存在，内容可自定义」）
--
-- 四个附属模块：官文管理（PRD 4.5/8.5）、邮件送达登记（PRD 4.6/8.6）、
-- 动作记录（PRD 4.8）、申报结果记录（PRD 4.9）。
--
-- 归属关系严格按 PRD：
--   官文       → 项目
--   邮件送达   → 官文
--   动作记录   → 项目
--   申报结果   → 项目
--
-- 建模约定：PRD 列出的字段做成真实列（系统字段），其余由系统 B 配置为自定义字段存 customFields JSONB。
-- 全部软删除（deletedAt），数据保留、可恢复。

-- ---------------------------------------------------------------------------
-- 1. 官文管理
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "public"."OfficialDocument" (
    "id"                TEXT NOT NULL,
    "projectId"         TEXT NOT NULL,
    "documentType"      TEXT,
    "documentName"      TEXT NOT NULL,
    "issuingAuthority"  TEXT,
    "documentNo"        TEXT,
    "issuedAt"          TIMESTAMP(3),
    "deliveredAt"       TIMESTAMP(3),
    "source"            TEXT,
    "needsMailDelivery" BOOLEAN NOT NULL DEFAULT false,
    "note"              TEXT,
    "customFields"      JSONB,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,
    "deletedAt"         TIMESTAMP(3),

    CONSTRAINT "OfficialDocument_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OfficialDocument_projectId_idx"   ON "public"."OfficialDocument"("projectId");
CREATE INDEX IF NOT EXISTS "OfficialDocument_documentType_idx" ON "public"."OfficialDocument"("documentType");
CREATE INDEX IF NOT EXISTS "OfficialDocument_deliveredAt_idx" ON "public"."OfficialDocument"("deliveredAt");
CREATE INDEX IF NOT EXISTS "OfficialDocument_deletedAt_idx"   ON "public"."OfficialDocument"("deletedAt");

ALTER TABLE "public"."OfficialDocument" DROP CONSTRAINT IF EXISTS "OfficialDocument_projectId_fkey";
ALTER TABLE "public"."OfficialDocument"
  ADD CONSTRAINT "OfficialDocument_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. 邮件送达登记
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "public"."MailDelivery" (
    "id"                 TEXT NOT NULL,
    "officialDocumentId" TEXT NOT NULL,
    "recipientEmail"     TEXT NOT NULL,
    "sentAt"             TIMESTAMP(3),
    "sentById"           TEXT,
    "registeredById"     TEXT,
    "registeredAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusCode"         TEXT NOT NULL DEFAULT 'PENDING',
    "note"               TEXT,
    "customFields"       JSONB,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,
    "deletedAt"          TIMESTAMP(3),

    CONSTRAINT "MailDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MailDelivery_officialDocumentId_idx" ON "public"."MailDelivery"("officialDocumentId");
CREATE INDEX IF NOT EXISTS "MailDelivery_sentAt_idx"             ON "public"."MailDelivery"("sentAt");
CREATE INDEX IF NOT EXISTS "MailDelivery_statusCode_idx"         ON "public"."MailDelivery"("statusCode");
CREATE INDEX IF NOT EXISTS "MailDelivery_deletedAt_idx"          ON "public"."MailDelivery"("deletedAt");

ALTER TABLE "public"."MailDelivery" DROP CONSTRAINT IF EXISTS "MailDelivery_officialDocumentId_fkey";
ALTER TABLE "public"."MailDelivery"
  ADD CONSTRAINT "MailDelivery_officialDocumentId_fkey"
  FOREIGN KEY ("officialDocumentId") REFERENCES "public"."OfficialDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."MailDelivery" DROP CONSTRAINT IF EXISTS "MailDelivery_sentById_fkey";
ALTER TABLE "public"."MailDelivery"
  ADD CONSTRAINT "MailDelivery_sentById_fkey"
  FOREIGN KEY ("sentById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."MailDelivery" DROP CONSTRAINT IF EXISTS "MailDelivery_registeredById_fkey";
ALTER TABLE "public"."MailDelivery"
  ADD CONSTRAINT "MailDelivery_registeredById_fkey"
  FOREIGN KEY ("registeredById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. 动作记录
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "public"."ActionRecord" (
    "id"           TEXT NOT NULL,
    "projectId"    TEXT NOT NULL,
    "actionType"   TEXT NOT NULL,
    "actionAt"     TIMESTAMP(3) NOT NULL,
    "operatorId"   TEXT,
    "note"         TEXT,
    "customFields" JSONB,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    "deletedAt"    TIMESTAMP(3),

    CONSTRAINT "ActionRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ActionRecord_projectId_idx"  ON "public"."ActionRecord"("projectId");
CREATE INDEX IF NOT EXISTS "ActionRecord_actionType_idx" ON "public"."ActionRecord"("actionType");
CREATE INDEX IF NOT EXISTS "ActionRecord_actionAt_idx"   ON "public"."ActionRecord"("actionAt");
CREATE INDEX IF NOT EXISTS "ActionRecord_deletedAt_idx"  ON "public"."ActionRecord"("deletedAt");

ALTER TABLE "public"."ActionRecord" DROP CONSTRAINT IF EXISTS "ActionRecord_projectId_fkey";
ALTER TABLE "public"."ActionRecord"
  ADD CONSTRAINT "ActionRecord_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."ActionRecord" DROP CONSTRAINT IF EXISTS "ActionRecord_operatorId_fkey";
ALTER TABLE "public"."ActionRecord"
  ADD CONSTRAINT "ActionRecord_operatorId_fkey"
  FOREIGN KEY ("operatorId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. 申报结果记录
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "public"."FilingResult" (
    "id"           TEXT NOT NULL,
    "projectId"    TEXT NOT NULL,
    "resultCode"   TEXT NOT NULL,
    "recordedAt"   TIMESTAMP(3) NOT NULL,
    "recordedById" TEXT,
    "note"         TEXT,
    "customFields" JSONB,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    "deletedAt"    TIMESTAMP(3),

    CONSTRAINT "FilingResult_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "FilingResult_projectId_idx"  ON "public"."FilingResult"("projectId");
CREATE INDEX IF NOT EXISTS "FilingResult_resultCode_idx" ON "public"."FilingResult"("resultCode");
CREATE INDEX IF NOT EXISTS "FilingResult_recordedAt_idx" ON "public"."FilingResult"("recordedAt");
CREATE INDEX IF NOT EXISTS "FilingResult_deletedAt_idx"  ON "public"."FilingResult"("deletedAt");

ALTER TABLE "public"."FilingResult" DROP CONSTRAINT IF EXISTS "FilingResult_projectId_fkey";
ALTER TABLE "public"."FilingResult"
  ADD CONSTRAINT "FilingResult_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."FilingResult" DROP CONSTRAINT IF EXISTS "FilingResult_recordedById_fkey";
ALTER TABLE "public"."FilingResult"
  ADD CONSTRAINT "FilingResult_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
