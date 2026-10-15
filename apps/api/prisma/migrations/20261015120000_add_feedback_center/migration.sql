-- 用户反馈中心：所有用户可提交，接收部门成员按权限进入处理队列。
CREATE TABLE "public"."Feedback" (
    "id" TEXT NOT NULL,
    "feedbackNo" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "statusCode" TEXT NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT NOT NULL,
    "handledById" TEXT,
    "handlingNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."FeedbackRoutingDepartment" (
    "departmentId" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FeedbackRoutingDepartment_pkey" PRIMARY KEY ("departmentId")
);

CREATE UNIQUE INDEX "Feedback_feedbackNo_key" ON "public"."Feedback"("feedbackNo");
CREATE INDEX "Feedback_statusCode_createdAt_idx" ON "public"."Feedback"("statusCode", "createdAt");
CREATE INDEX "Feedback_createdById_createdAt_idx" ON "public"."Feedback"("createdById", "createdAt");

ALTER TABLE "public"."Feedback"
  ADD CONSTRAINT "Feedback_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."Feedback"
  ADD CONSTRAINT "Feedback_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."FeedbackRoutingDepartment"
  ADD CONSTRAINT "FeedbackRoutingDepartment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "public"."Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."FeedbackRoutingDepartment"
  ADD CONSTRAINT "FeedbackRoutingDepartment_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 新权限仅用于技术人员进入反馈处理队列；提交接口不要求该权限。
INSERT INTO "public"."Permission" ("id", "code", "name", "kind", "resource", "action", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::TEXT, 'feedback.manage', '处理反馈', 'OPERATION', 'feedback', 'manage', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE
SET "name" = EXCLUDED."name",
    "kind" = EXCLUDED."kind",
    "resource" = EXCLUDED."resource",
    "action" = EXCLUDED."action",
    "updatedAt" = CURRENT_TIMESTAMP;
