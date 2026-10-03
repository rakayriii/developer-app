ALTER TABLE "Project" ADD COLUMN "localRepositoryPath" TEXT;

CREATE TYPE "DeploymentEnvironmentType" AS ENUM ('development', 'staging', 'production');
CREATE TYPE "DeploymentStatus" AS ENUM ('pending', 'building', 'starting', 'running', 'unhealthy', 'failed', 'stopping', 'stopped', 'rolled_back');

CREATE TABLE "DeploymentEnvironment" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "type" "DeploymentEnvironmentType" NOT NULL,
  "containerPort" INTEGER NOT NULL DEFAULT 3000,
  "hostPort" INTEGER NOT NULL,
  "healthPath" TEXT NOT NULL DEFAULT '/',
  "healthTimeoutMs" INTEGER NOT NULL DEFAULT 5000,
  "healthRetries" INTEGER NOT NULL DEFAULT 5,
  "cpuLimit" TEXT NOT NULL DEFAULT '1.0',
  "memoryLimit" TEXT NOT NULL DEFAULT '512m',
  "restartPolicy" TEXT NOT NULL DEFAULT 'unless-stopped',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeploymentEnvironment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DeploymentEnvironment_projectId_slug_key" ON "DeploymentEnvironment"("projectId", "slug");
CREATE UNIQUE INDEX "DeploymentEnvironment_hostPort_key" ON "DeploymentEnvironment"("hostPort");
CREATE INDEX "DeploymentEnvironment_projectId_type_idx" ON "DeploymentEnvironment"("projectId", "type");
ALTER TABLE "DeploymentEnvironment" ADD CONSTRAINT "DeploymentEnvironment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Deployment" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "commitSha" TEXT NOT NULL,
  "branch" TEXT,
  "imageTag" TEXT NOT NULL,
  "containerId" TEXT,
  "containerName" TEXT,
  "status" "DeploymentStatus" NOT NULL DEFAULT 'pending',
  "healthStatus" TEXT,
  "errorMessage" TEXT,
  "rollbackOfId" TEXT,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Deployment_projectId_createdAt_idx" ON "Deployment"("projectId", "createdAt");
CREATE INDEX "Deployment_environmentId_status_idx" ON "Deployment"("environmentId", "status");
CREATE INDEX "Deployment_containerId_idx" ON "Deployment"("containerId");
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "DeploymentEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DeploymentLog" (
  "id" TEXT NOT NULL,
  "deploymentId" TEXT NOT NULL,
  "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "stream" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  CONSTRAINT "DeploymentLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DeploymentLog_deploymentId_timestamp_idx" ON "DeploymentLog"("deploymentId", "timestamp");
ALTER TABLE "DeploymentLog" ADD CONSTRAINT "DeploymentLog_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
