-- 阶段 3.1 补充：客户联系人邮箱（PRD 8.1）
--
-- PRD 8.1 客户管理默认字段包含「联系人邮箱」，并注明用途是「官文邮件主收件人来源」。
-- 本系统此前缺少该字段，导致合同侧的联系人邮箱快照也无源可取。阶段 4 的邮件送达登记会用到。

ALTER TABLE "public"."Customer" ADD COLUMN IF NOT EXISTS "email" TEXT;
