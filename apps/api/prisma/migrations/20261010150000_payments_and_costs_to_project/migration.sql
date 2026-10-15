-- 回款与成本改为「项目级登记、合同级汇总」。
--
-- 回款：收款单归属合同（PaymentReceipt.contractId），金额分摊到该合同下的项目
--       （PaymentAllocation 按合同分摊 → ProjectPaymentAllocation 按项目分摊）。
--       合同已收款 = 该合同下收款单金额之和；项目回款 = 分摊到该项目的金额之和。
-- 成本：由「可挂合同或项目」改为必须挂在项目上，contractId 作为便于汇总的冗余列。

-- 1. 收款单补合同归属（先建可空列，回填后再收紧为必填）
ALTER TABLE "public"."PaymentReceipt" ADD COLUMN IF NOT EXISTS "contractId" TEXT;

-- 旧分摊是按合同记录的：取每笔收款单的第一条分摊作为合同归属，尽量保留数据
DO $$
BEGIN
  IF to_regclass('public."PaymentAllocation"') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE "public"."PaymentReceipt" AS r
      SET "contractId" = a."contractId"
      FROM (
        SELECT DISTINCT ON ("paymentId") "paymentId", "contractId"
        FROM "public"."PaymentAllocation"
        ORDER BY "paymentId", "contractId"
      ) AS a
      WHERE a."paymentId" = r."id" AND r."contractId" IS NULL
    $sql$;
  END IF;
END $$;

-- 只有确实存在收款单时才允许 NOT NULL（空表直接通过）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."PaymentReceipt") THEN
    IF EXISTS (SELECT 1 FROM "public"."PaymentReceipt" WHERE "contractId" IS NULL) THEN
      RAISE EXCEPTION '存在无法确定所属合同的收款单，请先人工处理后重跑迁移';
    END IF;
    ALTER TABLE "public"."PaymentReceipt" ALTER COLUMN "contractId" SET NOT NULL;
  END IF;
END $$;

ALTER TABLE "public"."PaymentReceipt" DROP CONSTRAINT IF EXISTS "PaymentReceipt_contractId_fkey";
ALTER TABLE "public"."PaymentReceipt"
  ADD CONSTRAINT "PaymentReceipt_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "public"."Contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "PaymentReceipt_contractId_idx" ON "public"."PaymentReceipt"("contractId");
CREATE INDEX IF NOT EXISTS "PaymentReceipt_receivedAt_idx" ON "public"."PaymentReceipt"("receivedAt");

-- 2. 分摊表由合同维度改为项目维度
DROP TABLE IF EXISTS "public"."PaymentAllocation";

CREATE TABLE IF NOT EXISTS "public"."ProjectPaymentAllocation" (
    "paymentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "ProjectPaymentAllocation_pkey" PRIMARY KEY ("paymentId","projectId")
);

CREATE INDEX IF NOT EXISTS "ProjectPaymentAllocation_projectId_idx" ON "public"."ProjectPaymentAllocation"("projectId");

ALTER TABLE "public"."ProjectPaymentAllocation" DROP CONSTRAINT IF EXISTS "ProjectPaymentAllocation_paymentId_fkey";
ALTER TABLE "public"."ProjectPaymentAllocation"
  ADD CONSTRAINT "ProjectPaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "public"."PaymentReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."ProjectPaymentAllocation" DROP CONSTRAINT IF EXISTS "ProjectPaymentAllocation_projectId_fkey";
ALTER TABLE "public"."ProjectPaymentAllocation"
  ADD CONSTRAINT "ProjectPaymentAllocation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. 成本必须挂在项目上
ALTER TABLE "public"."CostRecord" ALTER COLUMN "contractId" DROP NOT NULL;
ALTER TABLE "public"."CostRecord" ALTER COLUMN "projectId" DROP NOT NULL;

-- 回填合同归属：按项目所属合同补齐
UPDATE "public"."CostRecord" AS c
SET "contractId" = p."contractId"
FROM "public"."Project" AS p
WHERE c."projectId" = p."id" AND c."contractId" IS NULL;

-- 无法归属到项目的旧数据（contractId 或 projectId 为空）删除，数量记入迁移日志
DO $$
DECLARE
  removed INTEGER;
BEGIN
  DELETE FROM "public"."CostRecord" WHERE "projectId" IS NULL OR "contractId" IS NULL;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE '已删除 % 条无法归属到项目的旧成本记录', removed;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."CostRecord") THEN
    IF EXISTS (SELECT 1 FROM "public"."CostRecord" WHERE "projectId" IS NULL OR "contractId" IS NULL) THEN
      RAISE EXCEPTION '存在无法归属到项目的成本记录，请先人工处理后重跑迁移';
    END IF;
    ALTER TABLE "public"."CostRecord" ALTER COLUMN "contractId" SET NOT NULL;
    ALTER TABLE "public"."CostRecord" ALTER COLUMN "projectId" SET NOT NULL;
  END IF;
END $$;

ALTER TABLE "public"."CostRecord" DROP CONSTRAINT IF EXISTS "CostRecord_contractId_fkey";
ALTER TABLE "public"."CostRecord"
  ADD CONSTRAINT "CostRecord_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "public"."Contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."CostRecord" DROP CONSTRAINT IF EXISTS "CostRecord_projectId_fkey";
ALTER TABLE "public"."CostRecord"
  ADD CONSTRAINT "CostRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "CostRecord_contractId_idx" ON "public"."CostRecord"("contractId");
CREATE INDEX IF NOT EXISTS "CostRecord_projectId_idx" ON "public"."CostRecord"("projectId");
CREATE INDEX IF NOT EXISTS "CostRecord_incurredAt_idx" ON "public"."CostRecord"("incurredAt");
