import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { allNavigationTargets, commandTargetHref, isKnownTarget, navGroups, routeSections, sectionFor } from "../src/lib/navigation.ts";

const root = path.resolve(import.meta.dirname, "..");

const read = (relative) => readFileSync(path.join(root, relative), "utf8");

function walk(directory) {
  const absolute = path.join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const nested = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(nested) : [nested];
  });
}

// The shell regression: seven routed pages used to render a bare <main> with no sidebar, topbar, or
// navigation at all, while two components each declared their own <main className="main-content">.
// Both halves of that are enforced here, because the failure is invisible in any single file.
describe("app shell is the single shell", () => {
  const components = walk("src/components").filter((file) => file.endsWith(".tsx"));
  const pages = walk("src/app").filter((file) => file.endsWith("page.tsx") || file.endsWith("layout.tsx"));

  it("declares <main> exactly once, in the shell", () => {
    const owners = [...components, ...pages].filter((file) => /<main[\s>]/.test(read(file)));
    assert.deepEqual(owners, ["src/components/app-shell.tsx"]);
  });

  it("declares the main-content container exactly once, in the shell", () => {
    const owners = [...components, ...pages].filter((file) => /className="[^"]*\bmain-content\b/.test(read(file)));
    assert.deepEqual(owners, ["src/components/app-shell.tsx"]);
  });

  it("keeps the sidebar and topbar inside the shell component alone", () => {
    const owners = [...components, ...pages].filter((file) => /className="[^"]*\b(sidebar|topbar)\b/.test(read(file)));
    assert.deepEqual(owners, ["src/components/app-shell.tsx"]);
  });

  it("renders the shell once, from the root layout", () => {
    const owners = [...components, ...pages].filter((file) => /<AppShell[\s>]/.test(read(file)));
    assert.deepEqual(owners, ["src/app/layout.tsx"]);
  });

  it("does not leave a dead standalone-* page wrapper class behind", () => {
    const css = read("src/app/globals.css");
    for (const file of pages) assert.doesNotMatch(read(file), /standalone-/, `${file} still wraps itself`);
    assert.doesNotMatch(css, /\.standalone-/, "a .standalone-* rule with no matching element is dead CSS");
  });

  it("gives every routed section a real page, so the active nav item is never a 404", () => {
    // The section a nav item points at is the one link that does not leave the route, so it is the
    // one link that must exist. /deployments used to be the only such page; /projects, /servers,
    // /github, /git, /terminal, and /system were all 404s from their own sibling pages.
    // The registry itself, not a regex over whichever file currently happens to hold it.
    const declared = routeSections.map((section) => section.prefix);
    assert.ok(declared.length > 0, "no routed sections declared");
    for (const prefix of declared) {
      assert.ok(existsSync(path.join(root, "src/app", prefix.replace(/^\//, ""), "page.tsx")), `no page for ${prefix}`);
    }
  });
});

// The reported bug: a response the browser cannot parse as JSON used to reach the UI and surface as
// a raw "Unexpected token '<'" message. The guard is worthless if a caller keeps bypassing it.
describe("no component parses an API response without the shared reader", () => {
  const components = walk("src/components").filter((file) => file.endsWith(".tsx"));

  it("uses readApiJson everywhere a fetch result is read", () => {
    const offenders = components.filter((file) => /\.json\(\)/.test(read(file)));
    assert.deepEqual(offenders, []);
  });

  it("reads API responses through the shared reader in every fetching component", () => {
    const fetchers = components.filter((file) => /fetch\(/.test(read(file)));
    assert.ok(fetchers.length > 0, "expected components that fetch");
    for (const file of fetchers) assert.match(read(file), /readApiJson/, `${file} fetches without readApiJson`);
  });
});

// A database outage must be distinguishable from "no data", or every panel silently reads as empty.
describe("database outage is classified, not swallowed", () => {
  const mappers = ["src/lib/deployments/api.ts", "src/lib/projects/errors.ts", "src/lib/servers/service.ts", "src/lib/github/route.ts"];

  for (const file of mappers) {
    it(`${file} routes through the shared error contract`, () => {
      assert.match(read(file), /api\/errors|api\/contract/);
    });
  }

  it("never reports an outage as an empty result set", () => {
    for (const file of mappers) {
      const source = read(file);
      assert.doesNotMatch(source, /items:\s*\[\]/, `${file} would answer with an empty array during an outage`);
    }
  });
});

// -------------------------------------------------------------------------------------------
// Regression: a browser reached /admin/dashboard#overview and saw a Next.js 404 inside the shell.
// That path is not a Developer OS route and is produced by nothing in the application; it was a stale
// browser target. The defect it exposed is that an unknown path rendered a dead end instead of landing
// on the workspace home.
// -------------------------------------------------------------------------------------------

describe("no navigation target points outside the routes Developer OS owns", () => {
  // Exercises the real registry the sidebar, the palette, and the quick links all share. Reading
  // app-shell.tsx as text could not show what it actually resolves to.

  it("resolves every sidebar entry to a known prefix or a home hash", () => {
    // From inside a routed section, and from home: both are states a real click can happen in.
    for (const pathname of ["/", "/deployments", "/servers/deployments-1", "/github/owner/repo"]) {
      for (const group of navGroups) {
        for (const [, id] of group.items) {
          const href = commandTargetHref(id, pathname);
          assert.ok(isKnownTarget(href), `${href} (from ${pathname}, nav ${id}) is not a route this app owns`);
        }
      }
    }
  });

  it("never produces /admin/dashboard or any other invented prefix", () => {
    // A direct assertion on the reported symptom, so a future change cannot quietly reintroduce it.
    const produced = allNavigationTargets();
    assert.ok(produced.length > 0, "there must be navigation targets to check");
    assert.ok(!produced.includes("/admin/dashboard"), "navigation must not target /admin/dashboard");
    for (const href of produced) {
      assert.ok(isKnownTarget(href), `${href} is not a route this app serves`);
      assert.doesNotMatch(href, /^\/admin(\/|$)/, `${href} points at a prefix this app does not serve`);
    }
  });

  it("maps every route section prefix to a page that is actually routed", () => {
    for (const section of routeSections) {
      // A section must exist as a real page, otherwise its nav entry is a dead link.
      assert.ok(existsSync(path.join(root, "src/app", section.prefix.replace(/^\//, ""), "page.tsx")), `${section.prefix} has no page.tsx`);
    }
  });

  it("treats the home hash as the workspace home", () => {
    assert.equal(commandTargetHref("overview", "/"), "#overview");
    // Already at home, so a home destination is a fragment, not a path back to the same page.
    assert.equal(commandTargetHref("projects", "/"), "#projects");
    assert.equal(commandTargetHref("overview", "/deployments"), "/#overview");
    assert.equal(commandTargetHref("deployments", "/deployments"), "/deployments");
  });

  it("recognises a deep path inside a section as that section", () => {
    assert.equal(sectionFor("/deployments/abc123").prefix, "/deployments");
    assert.equal(sectionFor("/github/owner/repo").prefix, "/github");
    // A prefix that merely starts with the same letters is a different page, not that section.
    assert.equal(sectionFor("/deploymentsomething"), undefined);
    assert.equal(sectionFor("/admin/dashboard"), undefined);
  });

  it("rejects the reported path as a target rather than trying to serve it", () => {
    assert.equal(isKnownTarget("/admin/dashboard"), false);
    assert.equal(isKnownTarget("/admin"), false);
    assert.equal(isKnownTarget("/deployments"), true);
    assert.equal(isKnownTarget("/deployments/x"), true);
    assert.equal(isKnownTarget("/#overview"), true);
    assert.equal(isKnownTarget("#overview"), true);
  });
});
