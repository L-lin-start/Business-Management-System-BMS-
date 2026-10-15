-- 阶段 2 补强：对齐 PRD 的提醒口径
--
-- 1) 新增提醒类型 PAYMENT_PENDING（待回款合同，PRD 4.10：项目全部走完 + 钱全部到账）
-- 2) 新增分级预警字段（PRD 4.7「分级预警」）：alertLevel + tierDays
-- 3) 新增看板口径所需的配置项：合同完成判定与分级预警阈值
--
-- 说明：PRD 第十章要求首页看板显示四项——今日待办 / 逾期项目 / 超时邮件登记 / 待回款合同。
-- 其中「超时邮件登记」依赖 4.6 邮件送达模块（尚未开发），本次先落地其余三项。

DO $$ BEGIN
  ALTER TYPE "public"."ReminderType" ADD VALUE IF NOT EXISTS 'PAYMENT_PENDING';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "public"."Reminder" ADD COLUMN IF NOT EXISTS "alertLevel" TEXT NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "public"."Reminder" ADD COLUMN IF NOT EXISTS "tierDays" INTEGER;

CREATE INDEX IF NOT EXISTS "Reminder_alertLevel_isHandled_idx" ON "public"."Reminder"("alertLevel", "isHandled");

-- 分级预警阈值（PRD 4.7）：剩余天数 ≤ 该档阈值时升级预警级别。
-- NOTICE 30 天、WARNING 15 天、URGENT 7 天；逾期单独为 OVERDUE 级别。
INSERT INTO "public"."SystemConfig" ("key", "value", "valueType", "label", "updatedAt") VALUES
  ('reminder.tierNoticeDays',  '30', 'NUMBER', '分级预警：提示档（剩余天数≤）', CURRENT_TIMESTAMP),
  ('reminder.tierWarningDays', '15', 'NUMBER', '分级预警：警告档（剩余天数≤）', CURRENT_TIMESTAMP),
  ('reminder.tierUrgentDays',  '7',  'NUMBER', '分级预警：紧急档（剩余天数≤）', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- 待回款提醒的宽限期：项目全部完成后多少天开始提醒收款（0 表示完成后立即提醒）
INSERT INTO "public"."SystemConfig" ("key", "value", "valueType", "label", "updatedAt") VALUES
  ('reminder.paymentGraceDays', '0', 'NUMBER', '项目完成后多少天开始提醒待回款', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
