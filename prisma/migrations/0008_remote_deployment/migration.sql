-- Phase 11: remote Docker deployment.
--
-- Every change here is additive. Existing environments and deployments default to the "local"
-- target, so Phase 8/9 behaviour and all existing rows are preserved untouched.

-- CreateEnum
CREATE TYPE "DeploymentTarget" AS ENUM ('local', 'remote');

-- AlterTable: the environment may now target a registered remote Server.
ALTER TABLE "DeploymentEnvironment" ADD COLUMN "target" "DeploymentTarget" NOT NULL DEFAULT 'local';
ALTER TABLE "DeploymentEnvironment" ADD COLUMN "serverId" TEXT;

-- Host ports are unique per Docker host, not globally. Existing rows are all local and keep the
-- scope "local", so the previous single-host guard still applies to them unchanged.
ALTER TABLE "DeploymentEnvironment" ADD COLUMN "portScopeKey" TEXT NOT NULL DEFAULT 'local';
DROP INDEX "DeploymentEnvironment_hostPort_key";
CREATE UNIQUE INDEX "DeploymentEnvironment_portScopeKey_hostPort_key" ON "DeploymentEnvironment"("portScopeKey", "hostPort");

-- AlterTable: the deployment records where it runs and how the image got there.
ALTER TABLE "Deployment" ADD COLUMN "target" "DeploymentTarget" NOT NULL DEFAULT 'local';
ALTER TABLE "Deployment" ADD COLUMN "serverId" TEXT;
ALTER TABLE "Deployment" ADD COLUMN "remoteImageTag" TEXT;
ALTER TABLE "Deployment" ADD COLUMN "transferBytes" BIGINT;
ALTER TABLE "Deployment" ADD COLUMN "transferStartedAt" TIMESTAMP(3);
ALTER TABLE "Deployment" ADD COLUMN "transferCompletedAt" TIMESTAMP(3);

-- Indexes
CREATE INDEX "DeploymentEnvironment_serverId_idx" ON "DeploymentEnvironment"("serverId");
CREATE INDEX "Deployment_serverId_idx" ON "Deployment"("serverId");

-- Foreign keys use RESTRICT: a server that still hosts an environment or a deployment cannot be
-- deleted, so a running remote deployment can never lose the record of where its container lives.
ALTER TABLE "DeploymentEnvironment" ADD CONSTRAINT "DeploymentEnvironment_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
