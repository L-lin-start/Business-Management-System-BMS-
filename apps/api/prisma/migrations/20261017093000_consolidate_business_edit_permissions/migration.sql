-- 将同一业务的新增与编辑权限合并为一个业务编辑权限。
-- 合同金额调整也属于合同编辑能力；查看、删除、导出、流程推进仍保持独立。

INSERT INTO "public"."Permission" ("id", "code", "name", "kind", "resource", "action", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::TEXT, 'customer.manage', '编辑客户', 'OPERATION', 'customer', 'manage', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'contract.manage', '编辑合同', 'OPERATION', 'contract', 'manage', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'project.manage', '编辑项目', 'OPERATION', 'project', 'manage', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid()::TEXT, 'cost.manage', '编辑成本', 'OPERATION', 'cost', 'manage', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE
SET "name" = EXCLUDED."name",
    "kind" = EXCLUDED."kind",
    "resource" = EXCLUDED."resource",
    "action" = EXCLUDED."action",
    "updatedAt" = CURRENT_TIMESTAMP;

-- 迁移旧权限授权，并保留同一角色旧权限中最宽的数据范围。
WITH permission_map (old_code, new_code) AS (
  VALUES
    ('customer.create', 'customer.manage'),
    ('customer.update', 'customer.manage'),
    ('contract.create', 'contract.manage'),
    ('contract.update', 'contract.manage'),
    ('contract.adjust', 'contract.manage'),
    ('project.create', 'project.manage'),
    ('project.update', 'project.manage'),
    ('cost.create', 'cost.manage'),
    ('cost.update', 'cost.manage')
), consolidated AS (
  SELECT
    old_rp."roleId",
    new_p."id" AS "permissionId",
    BOOL_OR(old_rp."allowed") AS "allowed",
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
    END AS "dataScope"
  FROM "public"."RolePermission" old_rp
  JOIN "public"."Permission" old_p ON old_p."id" = old_rp."permissionId"
  JOIN permission_map pm ON pm.old_code = old_p."code"
  JOIN "public"."Permission" new_p ON new_p."code" = pm.new_code
  GROUP BY old_rp."roleId", new_p."id"
)
INSERT INTO "public"."RolePermission" ("roleId", "permissionId", "allowed", "dataScope")
SELECT "roleId", "permissionId", "allowed", "dataScope"
FROM consolidated
ON CONFLICT ("roleId", "permissionId") DO UPDATE
SET "allowed" = EXCLUDED."allowed",
    "dataScope" = EXCLUDED."dataScope";

DELETE FROM "public"."RolePermission"
WHERE "permissionId" IN (
  SELECT "id" FROM "public"."Permission"
  WHERE "code" IN (
    'customer.create', 'customer.update',
    'contract.create', 'contract.update', 'contract.adjust',
    'project.create', 'project.update',
    'cost.create', 'cost.update'
  )
);

DELETE FROM "public"."Permission"
WHERE "code" IN (
  'customer.create', 'customer.update',
  'contract.create', 'contract.update', 'contract.adjust',
  'project.create', 'project.update',
  'cost.create', 'cost.update'
);
