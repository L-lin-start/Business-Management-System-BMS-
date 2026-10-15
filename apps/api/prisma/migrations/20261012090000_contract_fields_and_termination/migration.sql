-- 阶段 3.1：补齐 PRD 8.2 合同字段 + 合同终止 5 要素（PRD 4.2）
--
-- PRD 8.2 合同管理默认字段中，本系统此前缺失：产品、单价、付款方式、备注，
-- 以及联系人信息的合同侧快照（公司名称/联系人/联系电话/联系人邮箱/公司地址）。
-- 这些字段在客户上已有，但合同需要留存签约当时的快照——客户信息日后变更不应影响历史合同。
--
-- PRD 4.2 合同终止要求记录：终止日期、类型、原因、未完成项目处理、未回款处理。

ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "product" TEXT;
ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "unitPrice" DECIMAL(18,2);
ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "paymentTerm" TEXT;
ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "remark" TEXT;
ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "companyName" TEXT;
ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "contactName" TEXT;
ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "contactPhone" TEXT;
ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "contactEmail" TEXT;
ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "companyAddress" TEXT;

ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "terminatedAt" TIMESTAMP(3);
ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "terminationType" TEXT;
ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "terminationReason" TEXT;
ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "unfinishedProjectAction" TEXT;
ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "unpaidAmountAction" TEXT;
ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "terminatedById" TEXT;

CREATE INDEX IF NOT EXISTS "Contract_terminatedAt_idx" ON "public"."Contract"("terminatedAt");

ALTER TABLE "public"."Contract" DROP CONSTRAINT IF EXISTS "Contract_terminatedById_fkey";
ALTER TABLE "public"."Contract"
  ADD CONSTRAINT "Contract_terminatedById_fkey" FOREIGN KEY ("terminatedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 存量合同回填快照：取客户当前的联系人信息，避免历史合同这些字段全空
UPDATE "public"."Contract" c
SET "companyName"    = COALESCE(c."companyName", cu."name"),
    "contactName"    = COALESCE(c."contactName", cu."contactName"),
    "contactPhone"   = COALESCE(c."contactPhone", cu."phone"),
    "companyAddress" = COALESCE(c."companyAddress", cu."address")
FROM "public"."Customer" cu
WHERE c."customerId" = cu."id";

-- 合同金额调整表（退款 / 折扣 / 部分豁免）：不改原金额，单独记账，原值可追溯
CREATE TABLE IF NOT EXISTS "public"."ContractAmountAdjustment" (
  "id"         TEXT NOT NULL,
  "contractId" TEXT NOT NULL,
  "adjustType" TEXT NOT NULL,
  "amount"     DECIMAL(18,2) NOT NULL,
  "reason"     TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "operatorId" TEXT,
  "note"       TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  "deletedAt"  TIMESTAMP(3),
  CONSTRAINT "ContractAmountAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ContractAmountAdjustment_contractId_occurredAt_idx" ON "public"."ContractAmountAdjustment"("contractId", "occurredAt");
CREATE INDEX IF NOT EXISTS "ContractAmountAdjustment_adjustType_idx" ON "public"."ContractAmountAdjustment"("adjustType");

ALTER TABLE "public"."ContractAmountAdjustment" DROP CONSTRAINT IF EXISTS "ContractAmountAdjustment_contractId_fkey";
ALTER TABLE "public"."ContractAmountAdjustment"
  ADD CONSTRAINT "ContractAmountAdjustment_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "public"."Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."ContractAmountAdjustment" DROP CONSTRAINT IF EXISTS "ContractAmountAdjustment_operatorId_fkey";
ALTER TABLE "public"."ContractAmountAdjustment"
  ADD CONSTRAINT "ContractAmountAdjustment_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 新增下拉选项：付款方式（PRD 8.2 全款/分期/按进度）
INSERT INTO "public"."StatusDefinition" ("id", "moduleKey", "code", "label", "color", "sortOrder", "isActive", "isSystem", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::TEXT, 'paymentTerm', 'FULL',      '全款',   NULL, 10, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'paymentTerm', 'INSTALLMENT','分期',  NULL, 20, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'paymentTerm', 'BY_PROGRESS','按进度', NULL, 30, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("moduleKey", "code") DO NOTHING;

-- 合同终止类型（PRD 4.11：合同终止、退款、转业务、驳回）
INSERT INTO "public"."StatusDefinition" ("id", "moduleKey", "code", "label", "color", "sortOrder", "isActive", "isSystem", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::TEXT, 'terminationType', 'CUSTOMER_REQUEST', '客户要求终止', NULL, 10, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'terminationType', 'REFUND',           '退款',         NULL, 20, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'terminationType', 'TRANSFER_BUSINESS','转业务',       NULL, 30, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'terminationType', 'REJECTED',         '驳回',         NULL, 40, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'terminationType', 'OTHER',            '其他',         NULL, 50, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("moduleKey", "code") DO NOTHING;

-- 未完成项目的处理方式
INSERT INTO "public"."StatusDefinition" ("id", "moduleKey", "code", "label", "color", "sortOrder", "isActive", "isSystem", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::TEXT, 'unfinishedProjectAction', 'TERMINATE',  '项目一并终止',   NULL, 10, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'unfinishedProjectAction', 'KEEP_RUNNING','项目继续执行',  NULL, 20, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'unfinishedProjectAction', 'MOVE_TO_NEW', '转入新合同',     NULL, 30, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("moduleKey", "code") DO NOTHING;

-- 未回款的处理方式
INSERT INTO "public"."StatusDefinition" ("id", "moduleKey", "code", "label", "color", "sortOrder", "isActive", "isSystem", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::TEXT, 'unpaidAmountAction', 'WRITE_OFF',   '全额核销（不再收取）', NULL, 10, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'unpaidAmountAction', 'PARTIAL_WAIVE','部分豁免',           NULL, 20, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'unpaidAmountAction', 'KEEP_CLAIM',  '继续追讨',           NULL, 30, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'unpaidAmountAction', 'REFUND_PAID', '已收款需退回',       NULL, 40, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("moduleKey", "code") DO NOTHING;

-- 金额调整类型（退款 / 折扣 / 部分豁免 / 其他）
INSERT INTO "public"."StatusDefinition" ("id", "moduleKey", "code", "label", "color", "sortOrder", "isActive", "isSystem", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::TEXT, 'adjustType', 'REFUND',   '退款',     NULL, 10, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'adjustType', 'DISCOUNT', '折扣',     NULL, 20, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'adjustType', 'WAIVER',   '部分豁免', NULL, 30, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'adjustType', 'OTHER',    '其他',     NULL, 40, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("moduleKey", "code") DO NOTHING;

-- 权限点：合同终止与金额调整是敏感操作，单独授权
INSERT INTO "public"."Permission" ("id", "code", "name", "kind", "resource", "action", "createdAt", "updatedAt") VALUES
  (gen_random_uuid()::TEXT, 'contract.terminate', '终止合同',   'OPERATION', 'contract', 'terminate', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'contract.adjust',    '合同金额调整', 'OPERATION', 'contract', 'adjust',    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "public"."RolePermission" ("roleId", "permissionId", "allowed", "dataScope")
SELECT r."id", p."id", true, 'ALL'
FROM "public"."Role" r, "public"."Permission" p
WHERE r."code" = 'SYSTEM_ADMIN' AND p."code" IN ('contract.terminate', 'contract.adjust')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
