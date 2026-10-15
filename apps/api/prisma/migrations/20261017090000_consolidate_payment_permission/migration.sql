-- 回款权限由多个操作点统一为一个“编辑回款”权限。
-- 该权限同时覆盖查看、新增、修改、删除、导出；数据范围仍保留在 RolePermission.dataScope。

INSERT INTO "public"."Permission" ("id", "code", "name", "kind", "resource", "action", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::TEXT, 'payment.manage', '编辑回款', 'OPERATION', 'payment', 'manage', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE
SET "name" = EXCLUDED."name",
    "kind" = EXCLUDED."kind",
    "resource" = EXCLUDED."resource",
    "action" = EXCLUDED."action",
    "updatedAt" = CURRENT_TIMESTAMP;

-- 将旧权限的角色授权合并到新权限，保留原角色的最宽数据范围。
INSERT INTO "public"."RolePermission" ("roleId", "permissionId", "allowed", "dataScope")
SELECT
  old_rp."roleId",
  new_p."id",
  BOOL_OR(old_rp."allowed"),
  CASE MIN(CASE old_rp."dataScope"::TEXT
    WHEN 'ALL' THEN 1
    WHEN 'DEPARTMENT_AND_DESCENDANTS' THEN 2
    WHEN 'DEPARTMENT' THEN 3
    WHEN 'RELATED' THEN 4
    WHEN 'SELF' THEN 5
    ELSE 6
  END)
    WHEN 1 THEN 'ALL'::"public"."DataScope"
    WHEN 2 THEN 'DEPARTMENT_AND_DESCENDANTS'::"public"."DataScope"
    WHEN 3 THEN 'DEPARTMENT'::"public"."DataScope"
    WHEN 4 THEN 'RELATED'::"public"."DataScope"
    WHEN 5 THEN 'SELF'::"public"."DataScope"
    ELSE 'NONE'::"public"."DataScope"
  END
FROM "public"."RolePermission" old_rp
JOIN "public"."Permission" old_p ON old_p."id" = old_rp."permissionId"
CROSS JOIN "public"."Permission" new_p
WHERE old_p."code" IN ('payment.read', 'payment.create', 'payment.update', 'payment.delete', 'payment.export')
  AND new_p."code" = 'payment.manage'
GROUP BY old_rp."roleId", new_p."id"
ON CONFLICT ("roleId", "permissionId") DO UPDATE
SET "allowed" = EXCLUDED."allowed",
    "dataScope" = EXCLUDED."dataScope";

DELETE FROM "public"."RolePermission"
WHERE "permissionId" IN (
  SELECT "id" FROM "public"."Permission"
  WHERE "code" IN ('payment.read', 'payment.create', 'payment.update', 'payment.delete', 'payment.export')
);

DELETE FROM "public"."Permission"
WHERE "code" IN ('payment.read', 'payment.create', 'payment.update', 'payment.delete', 'payment.export');
