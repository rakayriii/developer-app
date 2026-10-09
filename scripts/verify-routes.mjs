// Real HTTP verification of route handling.
//
// The unit tests exercise the navigation registry in isolation. This checks the behaviour a person
// actually sees: a stale link must land on the workspace home with the shell rendered, a real route must
// stay where it is, and an unknown API path must stay JSON rather than becoming an HTML page.
//
//   node scripts/verify-routes.mjs [baseUrl]

const base = process.argv[2] || process.env.BASE_URL || "http://localhost:3000";

const problems = [];
const fail = (message) => { problems.push(message); console.error(`   !! ${message}`); };
const log = (...parts) => console.log(...parts);

/** Follows redirects manually so the intermediate hop is observable. */
async function probe(path, { followRedirects = false } = {}) {
  const response = await fetch(`${base}${path}`, { redirect: followRedirects ? "follow" : "manual" });
  const body = response.status === 204 || response.status === 304 ? "" : await response.text().catch(() => "");
  return { status: response.status, location: response.headers.get("location"), type: response.headers.get("content-type") || "", body };
}

log(`\nroute handling against ${base}\n`);

// -------------------------------------------------------------------------------------------
log("1. the reported failure: /admin/dashboard is not a route this app owns");
{
  const response = await probe("/admin/dashboard");
  log(`   GET /admin/dashboard -> ${response.status}${response.location ? ` -> ${response.location}` : ""}`);

  // Either it redirects home, or it must not pretend to be a page. What it must never do is render a
  // dead end inside the shell.
  if (response.status === 404) {
    fail("still renders a dead-end 404; an unknown path must land on the workspace home");
  }
  if (response.status >= 300 && response.status < 400) {
    if (response.location !== "/#overview") fail(`redirected to ${response.location}, expected /#overview`);
  }

  const followed = await probe("/admin/dashboard", { followRedirects: true });
  log(`   following it -> ${followed.status}`);
  if (followed.status !== 200) fail(`following the redirect gave ${followed.status}`);
  if (!followed.body.includes("Primary navigation")) fail("the workspace shell was not rendered on the destination");
  if (followed.body.includes("This page could not be found")) fail("a Next.js 404 was rendered inside the app");
}

log("\n2. other invented or stale paths behave the same way");
for (const path of ["/admin", "/admin/dashboard#overview", "/dashboard", "/wp-admin", "/index.php"]) {
  const response = await probe(path);
  const ok = response.status === 200 || (response.status >= 300 && response.status < 400);
  log(`   ${path.padEnd(24)} -> ${response.status}${response.location ? ` ${response.location}` : ""}${ok ? "" : "  (unexpected)"}`);
  if (!ok) fail(`${path} returned ${response.status}`);
  if (response.body.includes("This page could not be found")) fail(`${path} rendered a Next.js 404`);
}

log("\n3. real routes are untouched");
{
  const routes = ["/", "/deployments", "/servers", "/projects", "/git", "/github", "/terminal", "/system"];
  for (const route of routes) {
    const response = await probe(route);
    log(`   ${route.padEnd(14)} -> ${response.status}`);
    if (response.status !== 200) fail(`${route} returned ${response.status}, expected 200`);
  }
}

log("\n4. deep links inside a section still work");
for (const route of ["/deployments/not-a-real-id", "/servers/not-a-real-id", "/github/repositories/o/r", "/projects/not-a-real-id"]) {
  const response = await probe(route);
  log(`   ${route.padEnd(28)} -> ${response.status}`);
  if (response.status !== 200) fail(`${route} returned ${response.status}, expected the section shell`);
}

log("\n5. an unknown API path stays JSON");
{
  const response = await probe("/api/definitely-not-a-route");
  log(`   GET /api/definitely-not-a-route -> ${response.status} ${response.type}`);
  if (!response.type.includes("application/json")) fail(`an unknown API path returned ${response.type}, not JSON`);
  let parsed = null;
  try { parsed = JSON.parse(response.body); } catch { fail("the API 404 body is not valid JSON"); }
  if (response.status !== 404) fail(`an unknown API path returned ${response.status}, expected 404`);
  if (parsed && typeof parsed.code !== "string") fail("the API 404 does not follow the { code, message } contract");
  if (parsed && typeof parsed.message !== "string") fail("the API 404 does not follow the { code, message } contract");
}

log("\n6. authenticated API routes still answer in JSON");
for (const route of ["/api/domains", "/api/projects", "/api/servers"]) {
  const response = await probe(route);
  log(`   ${route.padEnd(18)} -> ${response.status} ${response.type}`);
  if (response.status !== 401) fail(`${route} returned ${response.status}, expected 401 without a session`);
  if (!response.type.includes("application/json")) fail(`${route} returned ${response.type}, not JSON`);
}

log(problems.length ? `\nRESULT: FAILED (${problems.length} problem(s))` : "\nRESULT: PASSED");
process.exit(problems.length ? 1 : 0);