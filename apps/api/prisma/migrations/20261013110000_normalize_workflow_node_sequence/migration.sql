-- 流程节点顺序必须在同一版本内连续且不可重复。
-- 对历史重复序号按“目标序号优先、同序号后创建者优先”整理：
-- 后插入到序号 3 的节点保留在 3，原序号 3 及后续节点自动后移。
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "versionId"
      ORDER BY "sequence" ASC, "createdAt" DESC, "id" ASC
    )::INTEGER AS "newSequence"
  FROM "public"."WorkflowNode"
)
UPDATE "public"."WorkflowNode" node
SET "sequence" = ranked."newSequence"
FROM ranked
WHERE node."id" = ranked."id";

DROP INDEX IF EXISTS "public"."WorkflowNode_versionId_sequence_idx";
CREATE UNIQUE INDEX "WorkflowNode_versionId_sequence_key"
  ON "public"."WorkflowNode"("versionId", "sequence");
