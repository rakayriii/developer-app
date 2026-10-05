CREATE TYPE "ServerAuthMethod" AS ENUM ('key');

CREATE TYPE "ServerStatus" AS ENUM ('unknown', 'online', 'offline', 'error');

CREATE TABLE "Server" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" TEXT NOT NULL,
    "authMethod" "ServerAuthMethod" NOT NULL DEFAULT 'key',
    "encryptedCredential" TEXT,
    "credentialFingerprint" TEXT,
    "credentialConfigured" BOOLEAN NOT NULL DEFAULT false,
    "hostKeyFingerprint" TEXT,
    "hostKeyTrustedAt" TIMESTAMP(3),
    "status" "ServerStatus" NOT NULL DEFAULT 'unknown',
    "statusCode" TEXT,
    "statusMessage" TEXT,
    "osName" TEXT,
    "osVersion" TEXT,
    "architecture" TEXT,
    "kernel" TEXT,
    "dockerVersion" TEXT,
    "dockerAvailable" BOOLEAN NOT NULL DEFAULT false,
    "cpuCount" INTEGER,
    "memoryBytes" BIGINT,
    "diskBytes" BIGINT,
    "diskFreeBytes" BIGINT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastConnectedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Server_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Server_userId_hostname_port_key" ON "Server"("userId", "hostname", "port");
CREATE INDEX "Server_userId_idx" ON "Server"("userId");
CREATE INDEX "Server_status_idx" ON "Server"("status");

CREATE TABLE "ServerCheck" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,

    "status" "ServerStatus" NOT NULL,
    "code" TEXT,
    "message" TEXT,
    "hostKeyFingerprint" TEXT,
    "hostKeyTrusted" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerCheck_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ServerCheck_serverId_createdAt_idx" ON "ServerCheck"("serverId", "createdAt");

ALTER TABLE "Server" ADD CONSTRAINT "Server_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServerCheck" ADD CONSTRAINT "ServerCheck_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
