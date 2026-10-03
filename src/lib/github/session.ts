import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";

const sessionCookie = "developer_os_github_session";
const stateCookie = "developer_os_github_oauth_state";

function secureCookie() {
  try { return new URL(process.env.APP_URL || "").protocol === "https:"; } catch { return process.env.NODE_ENV === "production"; }
}

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

function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${encode(iv)}.${encode(cipher.getAuthTag())}.${encode(encrypted)}`;
}

function decrypt(value: string) {
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

export async function getGithubAccessToken() {
  const value = (await cookies()).get(sessionCookie)?.value;
  if (!value) return null;
  return decrypt(value);
}

export function setGithubSession(response: NextResponse, accessToken: string) {
  response.cookies.set({
    name: sessionCookie,
    value: encrypt(accessToken),
    httpOnly: true,
    secure: secureCookie(),
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearGithubSession(response: NextResponse) {
  response.cookies.set({ name: sessionCookie, value: "", httpOnly: true, secure: secureCookie(), sameSite: "lax", path: "/", maxAge: 0 });
}

export async function createOauthState(response: NextResponse) {
  const state = encode(randomBytes(32));
  response.cookies.set({ name: stateCookie, value: state, httpOnly: true, secure: secureCookie(), sameSite: "lax", path: "/", maxAge: 600 });
  return state;
}

export async function consumeOauthState(value: string | null) {
  const expected = (await cookies()).get(stateCookie)?.value;
  return Boolean(value && expected && value === expected);
}

export function clearOauthState(response: NextResponse) {
  response.cookies.set({ name: stateCookie, value: "", httpOnly: true, secure: secureCookie(), sameSite: "lax", path: "/", maxAge: 0 });
}
