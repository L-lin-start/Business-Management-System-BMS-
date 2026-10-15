-- 流程模板增加「预置模板」标记，用于区分系统预置模板与用户自建模板。
--
-- 背景：PRD 5.4 要求流程模板「预置模板 + 可自定义」。但此前没有任何字段区分二者，
-- 导致用户在「管理系统 → 流程管理」里新建的模板**无法删除**（不是漏做按钮，
-- 而是缺少"哪些能删"的判定依据）——删掉预置的「专利/商标/软著/项目/通用流程」
-- 会破坏项目按类型匹配流程，其中「通用流程」还是代码里写死的兜底模板。
--
-- 回填策略：把种子里预置的 5 个模板按**名称**标记为 isSystem。
-- 用户自建的同名模板不会被标记（若真出现同名，以先创建者为准，属于极端边界）。

ALTER TABLE "public"."WorkflowTemplate"
  ADD COLUMN IF NOT EXISTS "isSystem" BOOLEAN NOT NULL DEFAULT false;

UPDATE "public"."WorkflowTemplate"
   SET "isSystem" = true,
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "name" IN ('专利', '商标', '软著', '项目', '通用流程')
   AND "moduleKey" = 'project';
