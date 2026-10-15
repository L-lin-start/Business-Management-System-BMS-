-- 内置合同/项目类型属于系统业务基线，不允许被删除或停用。
-- 自定义类型仍可通过管理系统执行软删除，历史合同和项目保留原值。
UPDATE "public"."StatusDefinition"
SET "isSystem" = true,
    "isActive" = true
WHERE ("moduleKey" = 'contractType' AND "code" IN ('PATENT', 'TRADEMARK', 'COPYRIGHT', 'PROJECT', 'OTHER'))
   OR ("moduleKey" = 'projectType' AND "code" IN ('PATENT', 'TRADEMARK', 'COPYRIGHT', 'PROJECT'));
