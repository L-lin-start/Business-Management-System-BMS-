/*
  Warnings:

  - Made the column `contractId` on table `CostRecord` required. This step will fail if there are existing NULL values in that column.
  - Made the column `projectId` on table `CostRecord` required. This step will fail if there are existing NULL values in that column.

  说明（2026-10-14）：本迁移原先的目录时间戳是 20261010091155，早于它所依赖的迁移，
  导致在**全新数据库**上按顺序应用时会引用尚未创建的列（`PaymentReceipt.contractId`）。
  已改名为 20261015090000 排到依赖之后，并把重复操作改为幂等，
  使「从零建库」能一次跑通（以前只有开发库能跑，因为它是边开发边增量应用的）。
*/
-- AlterTable
ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "businessStartAt" TIMESTAMP(3);

-- 新字段只对新业务要求人工填写；历史合同保留原录入时间作为兼容值。
UPDATE "public"."Contract" SET "businessStartAt" = "createdAt" WHERE "businessStartAt" IS NULL;

-- 生产库必须允许跨合同回款；旧数据先保留原合同归属。
ALTER TABLE "public"."PaymentReceipt" ALTER COLUMN "contractId" DROP NOT NULL;

-- CreateTable
CREATE TABLE IF NOT EXISTS "public"."PaymentContractAllocation" (
    "paymentId" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "PaymentContractAllocation_pkey" PRIMARY KEY ("paymentId","contractId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentContractAllocation_contractId_idx" ON "public"."PaymentContractAllocation"("contractId");

-- AddForeignKey
ALTER TABLE "public"."PaymentContractAllocation" DROP CONSTRAINT IF EXISTS "PaymentContractAllocation_paymentId_fkey";
ALTER TABLE "public"."PaymentContractAllocation" ADD CONSTRAINT "PaymentContractAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "public"."PaymentReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PaymentContractAllocation" DROP CONSTRAINT IF EXISTS "PaymentContractAllocation_contractId_fkey";
ALTER TABLE "public"."PaymentContractAllocation" ADD CONSTRAINT "PaymentContractAllocation_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "public"."Contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 把历史的单合同回款转换为合同分配，确保新旧口径一致。
INSERT INTO "public"."PaymentContractAllocation" ("paymentId", "contractId", "amount")
SELECT "id", "contractId", "amount"
FROM "public"."PaymentReceipt"
WHERE "contractId" IS NOT NULL
ON CONFLICT ("paymentId", "contractId") DO NOTHING;

-- 补充 PRD 要求的坏账调整类型。
INSERT INTO "public"."StatusDefinition" ("id", "moduleKey", "code", "label", "color", "sortOrder", "isActive", "isSystem", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::TEXT, 'adjustType', 'BAD_DEBT', '坏账', NULL, 30, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("moduleKey", "code") DO NOTHING;
