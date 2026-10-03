import { NextResponse } from "next/server";
import { createOauthState } from "@/lib/github/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const appUrl = process.env.APP_URL;
  if (!clientId || !appUrl) return NextResponse.json({ message: "GitHub OAuth is not configured." }, { status: 500 });

  const response = NextResponse.redirect(new URL("https://github.com/login/oauth/authorize"));
  const state = await createOauthState(response);
  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", new URL("/api/auth/github/callback", appUrl).toString());
  authorizeUrl.searchParams.set("scope", "read:user user:email repo");
  authorizeUrl.searchParams.set("state", state);

  response.headers.set("Location", authorizeUrl.toString());
  return response;
}
