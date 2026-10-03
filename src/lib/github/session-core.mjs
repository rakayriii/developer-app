import { createDecipheriv, createHash } from "node:crypto";

export const githubSessionCookie = "developer_os_github_session";

function decode(value) {
  return Buffer.from(value, "base64url");
}

export function decryptGithubSession(value, secret = process.env.SESSION_SECRET) {
  if (!value || !secret) return null;
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), decode(ivValue));
    decipher.setAuthTag(decode(tagValue));
    return Buffer.concat([decipher.update(decode(encryptedValue)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function cookieValue(header, name) {
  return header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || null;
}
