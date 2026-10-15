-- 阶段 1b：流程节点落地（模板/版本/节点已有表，本次补实例侧绑定）
--
-- 建模约定（沿用设计文档）：
--   WorkflowTemplate / WorkflowVersion / WorkflowNode 是「模板层」，定义流程长什么样；
--   Project.workflowVersionId / currentNodeCode / currentNodeEnteredAt 是「实例侧绑定」，
--   记录某个项目走的是哪个版本、当前在哪个节点；
--   ProjectNodeHistory 记录实际流转轨迹。
--
-- 已有项目不绑定流程（workflowVersionId 为空），首次推进节点时会自动绑定当前已发布版本。

ALTER TABLE "public"."Project" ADD COLUMN IF NOT EXISTS "workflowVersionId" TEXT;
ALTER TABLE "public"."Project" ADD COLUMN IF NOT EXISTS "currentNodeCode" TEXT;
ALTER TABLE "public"."Project" ADD COLUMN IF NOT EXISTS "currentNodeEnteredAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Project_workflowVersionId_idx" ON "public"."Project"("workflowVersionId");
CREATE INDEX IF NOT EXISTS "Project_currentNodeCode_idx" ON "public"."Project"("currentNodeCode");

ALTER TABLE "public"."Project" DROP CONSTRAINT IF EXISTS "Project_workflowVersionId_fkey";
ALTER TABLE "public"."Project"
  ADD CONSTRAINT "Project_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "public"."WorkflowVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 节点推进单独授权（PRD 3.2 的「节点权限」）：与项目编辑分开，避免"能改项目名"就等于"能推进流程"
INSERT INTO "public"."Permission" ("id", "code", "name", "kind", "resource", "action", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::TEXT, 'project.transition', '推进项目节点', 'NODE', 'project', 'transition', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- 系统管理员默认拥有该权限
INSERT INTO "public"."RolePermission" ("roleId", "permissionId", "allowed", "dataScope")
SELECT r."id", p."id", true, 'ALL'
FROM "public"."Role" r, "public"."Permission" p
WHERE r."code" = 'SYSTEM_ADMIN' AND p."code" = 'project.transition'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
