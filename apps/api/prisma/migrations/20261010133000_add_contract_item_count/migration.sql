-- 合同件数：PRD 要求合同录入后按件数自动生成项目（例如件数 4 生成 HT2026001-1 ~ -4）。
-- 已有合同默认为 1 件；件数只影响「创建合同时」的项目生成，后续修改件数不会自动增删项目。

ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "itemCount" INTEGER NOT NULL DEFAULT 1;
