-- 将默认角色的数据范围和业务操作权限固化到已存在的开发数据库。
-- 业务数据权限：销售=本人，代理人=关联，流程人员/复核人=本部门，财务=全部。

UPDATE "public"."RolePermission" rp
SET "dataScope" = CASE r."code"
  WHEN 'SALES' THEN 'SELF'::"DataScope"
  WHEN 'PATENT_AGENT' THEN 'RELATED'::"DataScope"
  WHEN 'TRADEMARK_AGENT' THEN 'RELATED'::"DataScope"
  WHEN 'PROCESS_STAFF' THEN 'DEPARTMENT'::"DataScope"
  WHEN 'FILING_REVIEWER' THEN 'DEPARTMENT'::"DataScope"
  ELSE rp."dataScope"
END
FROM "public"."Role" r, "public"."Permission" p
WHERE r."id" = rp."roleId"
  AND p."id" = rp."permissionId"
  AND r."code" IN ('SALES', 'PATENT_AGENT', 'TRADEMARK_AGENT', 'PROCESS_STAFF', 'FILING_REVIEWER')
  AND p."resource" IN ('customer', 'contract', 'project');

-- 销售可以维护自己负责的客户、合同和项目；敏感回款/成本仍由财务权限控制。
INSERT INTO "public"."RolePermission" ("roleId", "permissionId", "allowed", "dataScope")
SELECT r."id", p."id", true, 'SELF'::"DataScope"
FROM "public"."Role" r
CROSS JOIN "public"."Permission" p
WHERE r."code" = 'SALES'
  AND p."code" IN (
    'customer.read', 'customer.create', 'customer.update', 'customer.delete', 'customer.export',
    'contract.read', 'contract.create', 'contract.update', 'contract.delete', 'contract.export',
    'project.read', 'project.create', 'project.update', 'project.delete', 'project.export'
  )
ON CONFLICT ("roleId", "permissionId") DO UPDATE
SET "allowed" = EXCLUDED."allowed", "dataScope" = EXCLUDED."dataScope";
