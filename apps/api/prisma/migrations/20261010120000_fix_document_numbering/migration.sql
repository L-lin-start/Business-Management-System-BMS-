-- 单据编号规则修正：合同号改为 HT + 签约年份 + 3 位顺序号，项目号改为「合同号-序号」，回款号改为 HK + 年份 + 3 位顺序号。
-- 顺序号改由 DocumentSequence 计数表原子分配，不再使用「日期 + 随机串」。

-- 1. 新增单据流水号计数表
CREATE TABLE IF NOT EXISTS "public"."DocumentSequence" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentSequence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DocumentSequence_scope_prefix_year_key" ON "public"."DocumentSequence"("scope", "prefix", "year");

-- 2. 清空测试业务数据。旧编号（CON-/PRJ-/PAY-）与新规则不兼容，按约定不保留、不迁移。
--    用户、部门、角色、权限、字段定义等基础配置全部保留。
TRUNCATE TABLE "public"."PaymentAllocation", "public"."PaymentReceipt", "public"."CostRecord", "public"."Project", "public"."Contract" CASCADE;

-- 3. 计数器与现存单据对账：取同前缀同类型已用最大顺序号作为起点。
--    当前业务数据已清空，因此两个计数器都会归零，下一张合同从 HT<年>001 开始。
--    若日后在已有数据的库上执行本迁移，这段逻辑可避免新编号与存量编号撞号。
DO $$
DECLARE
    target_year INTEGER;
    max_sequence INTEGER;
BEGIN
    FOR target_year IN SELECT DISTINCT EXTRACT(YEAR FROM "signedAt")::INTEGER FROM "public"."Contract" WHERE "signedAt" IS NOT NULL
    LOOP
        SELECT COALESCE(MAX(NULLIF(regexp_replace("contractNo", '^HT[0-9]{4}', ''), '')::INTEGER), 0)
        INTO max_sequence
        FROM "public"."Contract"
        WHERE "contractNo" ~ ('^HT' || target_year::TEXT || '[0-9]+$');

        INSERT INTO "public"."DocumentSequence" ("id", "scope", "prefix", "year", "lastValue", "updatedAt")
        VALUES (gen_random_uuid()::TEXT, 'contract', 'HT', target_year, max_sequence, CURRENT_TIMESTAMP)
        ON CONFLICT ("scope", "prefix", "year") DO UPDATE SET "lastValue" = GREATEST("public"."DocumentSequence"."lastValue", EXCLUDED."lastValue"), "updatedAt" = CURRENT_TIMESTAMP;
    END LOOP;

    FOR target_year IN SELECT DISTINCT EXTRACT(YEAR FROM "receivedAt")::INTEGER FROM "public"."PaymentReceipt" WHERE "receivedAt" IS NOT NULL
    LOOP
        SELECT COALESCE(MAX(NULLIF(regexp_replace("receiptNo", '^HK[0-9]{4}', ''), '')::INTEGER), 0)
        INTO max_sequence
        FROM "public"."PaymentReceipt"
        WHERE "receiptNo" ~ ('^HK' || target_year::TEXT || '[0-9]+$');

        INSERT INTO "public"."DocumentSequence" ("id", "scope", "prefix", "year", "lastValue", "updatedAt")
        VALUES (gen_random_uuid()::TEXT, 'payment', 'HK', target_year, max_sequence, CURRENT_TIMESTAMP)
        ON CONFLICT ("scope", "prefix", "year") DO UPDATE SET "lastValue" = GREATEST("public"."DocumentSequence"."lastValue", EXCLUDED."lastValue"), "updatedAt" = CURRENT_TIMESTAMP;
    END LOOP;
END $$;
