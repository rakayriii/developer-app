import { NextResponse } from "next/server";
import { clearOauthState, consumeOauthState, setGithubSession } from "@/lib/github/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const appUrl = process.env.APP_URL;
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!appUrl || !clientId || !clientSecret || !code || !(await consumeOauthState(state))) {
    return NextResponse.json({ message: "The GitHub sign-in request could not be verified." }, { status: 400 });
  }

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: new URL("/api/auth/github/callback", appUrl).toString() }),
    cache: "no-store",
  });
  const tokenBody = (await tokenResponse.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!tokenResponse.ok || !tokenBody.access_token) return NextResponse.json({ message: "GitHub did not issue an access token." }, { status: 502 });

  const response = NextResponse.redirect(new URL("/#github", appUrl));
  clearOauthState(response);
  setGithubSession(response, tokenBody.access_token);
  return response;
}
