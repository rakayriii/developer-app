import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function secretKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  return createHash("sha256").update(secret).digest();
}

function encode(value: Buffer) {
  return value.toString("base64url");
}

function decode(value: string) {
  return Buffer.from(value, "base64url");
}

export function encryptSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${encode(iv)}.${encode(cipher.getAuthTag())}.${encode(encrypted)}`;
}

export function decryptSecret(value: string) {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", secretKey(), decode(ivValue));
    decipher.setAuthTag(decode(tagValue));
    return Buffer.concat([decipher.update(decode(encryptedValue)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
