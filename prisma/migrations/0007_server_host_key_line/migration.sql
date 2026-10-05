-- The public host key line is stored so subsequent connections pin the exact key with
-- StrictHostKeyChecking=yes. This avoids a fresh ssh-keyscan on every test, which the remote sshd
-- penalises as "connections without attempting authentication". Public key material, not a secret.
ALTER TABLE "Server" ADD COLUMN "hostKeyLine" TEXT;
