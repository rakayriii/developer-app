// Workspace navigation targets.
//
// This is the single registry that decides where every navigation action in the application lands: the
// sidebar links, the command palette, and the overview quick links. It lives here, free of React and JSX,
// so the routing rules can be exercised directly by tests instead of being asserted against source text.
//
// The invariant that matters: a navigation target is always either a route prefix this application serves,
// or a fragment on the home page. Nothing may resolve to an invented path.

export type ShellNavId = "overview" | "projects" | "terminal" | "git" | "deployments" | "tasks" | "notes" | "github" | "repositories" | "pull-requests" | "issues" | "docker" | "servers" | "system" | "settings";

export const navGroups = [
  { label: "Workspace", items: [["Overview", "overview"], ["Projects", "projects"], ["Terminal", "terminal"], ["Git", "git"], ["Tasks", "tasks"], ["Notes", "notes"]] },
  { label: "Development", items: [["GitHub", "github"], ["Repositories", "repositories"], ["Pull Requests", "pull-requests"], ["Issues", "issues"]] },
  { label: "Infrastructure", items: [["Deployments", "deployments"], ["Docker", "docker"], ["Servers", "servers"], ["System", "system"]] },
] as const;

export type RouteSection = { prefix: string; page: ShellNavId; title: string };

// The routed section a nav id resolves to. A nav id that is not a section page stays on the hash workspace.
export const routeSections: readonly RouteSection[] = [
  { prefix: "/deployments", page: "deployments", title: "Deployments" },
  { prefix: "/servers", page: "servers", title: "Servers" },
  { prefix: "/projects", page: "projects", title: "Projects" },
  { prefix: "/github", page: "github", title: "GitHub" },
  { prefix: "/git", page: "git", title: "Git" },
  { prefix: "/terminal", page: "terminal", title: "Terminal" },
  { prefix: "/system", page: "system", title: "System" },
];

export function sectionFor(pathname: string) {
  return routeSections.find((section) => pathname === section.prefix || pathname.startsWith(`${section.prefix}/`));
}

/**
 * Resolves a workspace id to the href the matching sidebar link would use.
 *
 * On the hash workspace every id is a fragment. On a routed section its own id is a real path and every
 * other id leaves the section for `/#id`, because changing only the fragment of the current route would
 * open nothing.
 */
export function commandTargetHref(id: string, pathname = "/") {
  const section = sectionFor(pathname);
  if (section && id !== section.page) return `/#${id}`;
  if (section) return section.prefix;
  return `#${id}`;
}

/** Every href any navigation entry can produce, across every location a click can happen from. */
export function allNavigationTargets() {
  const targets = new Set<string>();
  const origins = ["/", ...routeSections.map((section) => section.prefix)];
  for (const pathname of origins) {
    for (const group of navGroups) {
      for (const [, id] of group.items) targets.add(commandTargetHref(id, pathname));
    }
  }
  return [...targets];
}

/** True when `href` is somewhere this application actually serves. */
export function isKnownTarget(href: string) {
  if (href === "/") return true;
  if (href.startsWith("#")) return true;
  if (href.startsWith("/#")) return true;
  return routeSections.some((section) => href === section.prefix || href.startsWith(`${section.prefix}/`));
}