ALTER TABLE "DeploymentEnvironment" ADD COLUMN "runMigrations" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "DeploymentEnvironmentVariable" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "secret" BOOLEAN NOT NULL DEFAULT false,
    "value" TEXT,
    "secretValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeploymentEnvironmentVariable_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeploymentEnvironmentVariable_environmentId_name_key" ON "DeploymentEnvironmentVariable"("environmentId", "name");

ALTER TABLE "DeploymentEnvironmentVariable" ADD CONSTRAINT "DeploymentEnvironmentVariable_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "DeploymentEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
