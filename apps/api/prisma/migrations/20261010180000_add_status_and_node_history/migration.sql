-- 阶段 1a：状态与流程的可追溯
--   1) 合同/项目增加乐观锁版本号，避免多人同时编辑互相覆盖（PRD 非功能需求）
--   2) 新增状态变化历史表：回答"状态是怎么变成现在这样的"
--   3) 新增项目节点流转历史表：为流程引擎做实例侧建模（模板侧已有 WorkflowTemplate/Version/Node）

-- 1. 乐观锁版本号
ALTER TABLE "public"."Contract" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "public"."Project" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;

-- 2. 状态变化历史
CREATE TABLE IF NOT EXISTS "public"."StatusChangeHistory" (
    "id" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "fromStatusCode" TEXT,
    "toStatusCode" TEXT NOT NULL,
    "reason" TEXT,
    "operatorId" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusChangeHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "StatusChangeHistory_resourceType_resourceId_changedAt_idx"
  ON "public"."StatusChangeHistory"("resourceType", "resourceId", "changedAt");
CREATE INDEX IF NOT EXISTS "StatusChangeHistory_operatorId_idx"
  ON "public"."StatusChangeHistory"("operatorId");

ALTER TABLE "public"."StatusChangeHistory" DROP CONSTRAINT IF EXISTS "StatusChangeHistory_operatorId_fkey";
ALTER TABLE "public"."StatusChangeHistory"
  ADD CONSTRAINT "StatusChangeHistory_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. 项目节点流转历史
CREATE TABLE IF NOT EXISTS "public"."ProjectNodeHistory" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workflowVersionId" TEXT,
    "fromNodeCode" TEXT,
    "toNodeCode" TEXT NOT NULL,
    "operatorId" TEXT,
    "actionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" TIMESTAMP(3),
    "reason" TEXT,
    "note" TEXT,

    CONSTRAINT "ProjectNodeHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ProjectNodeHistory_projectId_actionAt_idx"
  ON "public"."ProjectNodeHistory"("projectId", "actionAt");
CREATE INDEX IF NOT EXISTS "ProjectNodeHistory_operatorId_idx"
  ON "public"."ProjectNodeHistory"("operatorId");

ALTER TABLE "public"."ProjectNodeHistory" DROP CONSTRAINT IF EXISTS "ProjectNodeHistory_projectId_fkey";
ALTER TABLE "public"."ProjectNodeHistory"
  ADD CONSTRAINT "ProjectNodeHistory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."ProjectNodeHistory" DROP CONSTRAINT IF EXISTS "ProjectNodeHistory_operatorId_fkey";
ALTER TABLE "public"."ProjectNodeHistory"
  ADD CONSTRAINT "ProjectNodeHistory_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. 数据回填：为现存合同/项目补一条"当前状态"的起始历史，
--    使历史记录从系统开始使用就是完整的，不会出现"有状态但查不到来源"。
INSERT INTO "public"."StatusChangeHistory" ("id", "resourceType", "resourceId", "fromStatusCode", "toStatusCode", "reason", "operatorId", "changedAt")
SELECT gen_random_uuid()::TEXT, 'Contract', c."id", NULL, c."statusCode", '迁移回填：系统启用时的初始状态', c."ownerId", c."createdAt"
FROM "public"."Contract" c
WHERE NOT EXISTS (
  SELECT 1 FROM "public"."StatusChangeHistory" h
  WHERE h."resourceType" = 'Contract' AND h."resourceId" = c."id"
);

INSERT INTO "public"."StatusChangeHistory" ("id", "resourceType", "resourceId", "fromStatusCode", "toStatusCode", "reason", "operatorId", "changedAt")
SELECT gen_random_uuid()::TEXT, 'Project', p."id", NULL, p."statusCode", '迁移回填：系统启用时的初始状态', p."ownerId", p."createdAt"
FROM "public"."Project" p
WHERE NOT EXISTS (
  SELECT 1 FROM "public"."StatusChangeHistory" h
  WHERE h."resourceType" = 'Project' AND h."resourceId" = p."id"
);
