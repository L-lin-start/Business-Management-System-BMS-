-- PRD 7.2（续）：附属记录同样需要"谁删的、为什么删"。
-- 上一支迁移只覆盖了 Contract / Project / Customer 三个核心模块，
-- 这里补齐回款、成本与四类附属记录，使级联作废时也能写明原因
-- （例如「所属合同「HT-001」已删除」），恢复时据此判断哪些子记录要一起恢复。

ALTER TABLE "PaymentReceipt" ADD COLUMN "deleteReason" TEXT;
ALTER TABLE "PaymentReceipt" ADD COLUMN "deletedBy" TEXT;

ALTER TABLE "CostRecord" ADD COLUMN "deleteReason" TEXT;
ALTER TABLE "CostRecord" ADD COLUMN "deletedBy" TEXT;

ALTER TABLE "OfficialDocument" ADD COLUMN "deleteReason" TEXT;
ALTER TABLE "OfficialDocument" ADD COLUMN "deletedBy" TEXT;

ALTER TABLE "MailDelivery" ADD COLUMN "deleteReason" TEXT;
ALTER TABLE "MailDelivery" ADD COLUMN "deletedBy" TEXT;

ALTER TABLE "ActionRecord" ADD COLUMN "deleteReason" TEXT;
ALTER TABLE "ActionRecord" ADD COLUMN "deletedBy" TEXT;

ALTER TABLE "FilingResult" ADD COLUMN "deleteReason" TEXT;
ALTER TABLE "FilingResult" ADD COLUMN "deletedBy" TEXT;
