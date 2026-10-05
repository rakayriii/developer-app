ALTER TABLE "Deployment" ADD COLUMN "lastStage" TEXT;
ALTER TABLE "Deployment" ADD COLUMN "stopReason" TEXT;
ALTER TABLE "Deployment" ADD COLUMN "restartedAt" TIMESTAMP(3);
ALTER TABLE "Deployment" ADD COLUMN "rolledBackFromId" TEXT;

CREATE INDEX "Deployment_rollbackOfId_idx" ON "Deployment"("rollbackOfId");
