-- Phase 12: application exposure. A hostname is routed through the reverse proxy on a registered
-- server to one deployment's published port.
--
-- Additive only. No existing column is altered and no row is rewritten, so every local and remote
-- deployment created through Phases 8-11 is untouched.

-- CreateEnum
CREATE TYPE "TlsMode" AS ENUM ('none', 'internal_ca', 'automatic');
CREATE TYPE "DomainStatus" AS ENUM ('pending', 'active', 'failed', 'disabled');

-- CreateTable
CREATE TABLE "DeploymentDomain" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "allowLocal" BOOLEAN NOT NULL DEFAULT false,
    "tlsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "tlsMode" "TlsMode" NOT NULL DEFAULT 'internal_ca',
    "status" "DomainStatus" NOT NULL DEFAULT 'pending',
    "statusCode" TEXT,
    "statusMessage" TEXT,
    "configHash" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeploymentDomain_pkey" PRIMARY KEY ("id")
);

-- A hostname may be routed only once per server; two domains sharing a name would make the generated
-- proxy configuration ambiguous.
CREATE UNIQUE INDEX "DeploymentDomain_serverId_hostname_key" ON "DeploymentDomain"("serverId", "hostname");
CREATE INDEX "DeploymentDomain_deploymentId_idx" ON "DeploymentDomain"("deploymentId");
CREATE INDEX "DeploymentDomain_serverId_status_idx" ON "DeploymentDomain"("serverId", "status");

-- Cascade from the deployment, because a domain is meaningless once its deployment is gone. Restrict
-- from the server, because a server that still routes traffic must not disappear underneath it.
ALTER TABLE "DeploymentDomain" ADD CONSTRAINT "DeploymentDomain_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeploymentDomain" ADD CONSTRAINT "DeploymentDomain_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE RESTRICT ON UPDATE CASCADE;