ALTER TABLE "Contract" ADD COLUMN "deleteReason" TEXT;
ALTER TABLE "Contract" ADD COLUMN "deletedBy" TEXT;
ALTER TABLE "Project" ADD COLUMN "deleteReason" TEXT;
ALTER TABLE "Project" ADD COLUMN "deletedBy" TEXT;
ALTER TABLE "Customer" ADD COLUMN "deleteReason" TEXT;
ALTER TABLE "Customer" ADD COLUMN "deletedBy" TEXT;