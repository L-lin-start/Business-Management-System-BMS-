-- 附件四项独立权限：查看、下载、上传、删除。
-- 附件动作权限与合同/项目的数据范围权限分离，便于系统 B 精确授权。
INSERT INTO "public"."Permission" ("id", "code", "name", "kind", "resource", "action", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::TEXT, 'attachment.read', '查看附件', 'FUNCTION', 'attachment', 'read', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'attachment.download', '下载附件', 'OPERATION', 'attachment', 'download', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'attachment.upload', '上传附件', 'OPERATION', 'attachment', 'upload', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'attachment.delete', '删除附件', 'OPERATION', 'attachment', 'delete', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE
SET "name" = EXCLUDED."name",
    "kind" = EXCLUDED."kind",
    "resource" = EXCLUDED."resource",
    "action" = EXCLUDED."action",
    "updatedAt" = CURRENT_TIMESTAMP;

-- 为已有角色继承原合同/项目权限的数据范围：
-- read/download 继承查看、编辑或删除业务数据的范围；upload 继承编辑范围；
-- delete 仅继承删除业务数据的范围，默认不扩大删除能力。
WITH role_capabilities AS (
  SELECT
    rp."roleId",
    BOOL_OR(p."code" IN ('contract.read', 'project.read', 'contract.manage', 'project.manage', 'contract.delete', 'project.delete')) AS "canRead",
    BOOL_OR(p."code" IN ('contract.manage', 'project.manage')) AS "canUpload",
    BOOL_OR(p."code" IN ('contract.delete', 'project.delete')) AS "canDelete",
    MIN(CASE rp."dataScope"::TEXT
      WHEN 'ALL' THEN 1
      WHEN 'DEPARTMENT_AND_DESCENDANTS' THEN 2
      WHEN 'DEPARTMENT' THEN 3
      WHEN 'RELATED' THEN 4
      WHEN 'SELF' THEN 5
      ELSE 6
    END) AS "scopeRank"
  FROM "public"."RolePermission" rp
  JOIN "public"."Permission" p ON p."id" = rp."permissionId"
  WHERE rp."allowed" = TRUE
    AND p."code" IN ('contract.read', 'project.read', 'contract.manage', 'project.manage', 'contract.delete', 'project.delete')
  GROUP BY rp."roleId"
), role_scopes AS (
  SELECT *, CASE "scopeRank"
    WHEN 1 THEN 'ALL'::"public"."DataScope"
    WHEN 2 THEN 'DEPARTMENT_AND_DESCENDANTS'::"public"."DataScope"
    WHEN 3 THEN 'DEPARTMENT'::"public"."DataScope"
    WHEN 4 THEN 'RELATED'::"public"."DataScope"
    WHEN 5 THEN 'SELF'::"public"."DataScope"
    ELSE 'NONE'::"public"."DataScope"
  END AS "dataScope"
  FROM role_capabilities
)
INSERT INTO "public"."RolePermission" ("roleId", "permissionId", "allowed", "dataScope")
SELECT rs."roleId", p."id", TRUE, rs."dataScope"
FROM role_scopes rs
CROSS JOIN LATERAL (VALUES
  ('attachment.read', rs."canRead"),
  ('attachment.download', rs."canRead"),
  ('attachment.upload', rs."canUpload"),
  ('attachment.delete', rs."canDelete")
) a("code", "enabled")
JOIN "public"."Permission" p ON p."code" = a."code"
WHERE a."enabled" = TRUE
ON CONFLICT ("roleId", "permissionId") DO UPDATE
SET "allowed" = EXCLUDED."allowed",
    "dataScope" = EXCLUDED."dataScope";
