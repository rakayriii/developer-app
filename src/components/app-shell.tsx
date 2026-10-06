"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

export type ShellNavId = "overview" | "projects" | "terminal" | "git" | "deployments" | "tasks" | "notes" | "github" | "repositories" | "pull-requests" | "issues" | "docker" | "servers" | "system" | "settings";

export const navGroups = [
  { label: "Workspace", items: [["Overview", "overview"], ["Projects", "projects"], ["Terminal", "terminal"], ["Git", "git"], ["Tasks", "tasks"], ["Notes", "notes"]] },
  { label: "Development", items: [["GitHub", "github"], ["Repositories", "repositories"], ["Pull Requests", "pull-requests"], ["Issues", "issues"]] },
  { label: "Infrastructure", items: [["Deployments", "deployments"], ["Docker", "docker"], ["Servers", "servers"], ["System", "system"]] },
] as const;

const iconFor = (id: string) => (id === "overview" ? "grid" : id === "projects" ? "folder" : id === "tasks" ? "check" : id === "notes" ? "note" : id === "github" ? "github" : id === "docker" ? "box" : id === "system" || id === "servers" ? "server" : "grid");

export function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
    folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2h8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z",
    check: "m5 12 4 4L19 6",
    note: "M6 3h9l3 3v15H6zM14 3v4h4M9 12h6M9 16h6",
    github: "M12 3a9 9 0 0 0-2.85 17.54c.45.08.61-.2.61-.43v-1.52c-2.5.54-3.03-1.06-3.03-1.06-.41-1.05-1-1.33-1-1.33-.82-.56.06-.55.06-.55.91.06 1.39.93 1.39.93.81 1.39 2.13.99 2.65.76.08-.59.32-.99.58-1.22-2-.23-4.1-1-4.1-4.45 0-.98.35-1.78.93-2.41-.09-.23-.4-1.14.09-2.37 0 0 .76-.24 2.48.92A8.6 8.6 0 0 1 12 7.51c.77 0 1.55.1 2.28.33 1.72-1.16 2.48-.92 2.48-.92.49 1.23.18 2.14.09 2.37.58.63.93 1.43.93 2.41 0 3.46-2.1 4.22-4.1 4.45.33.29.61.85.61 1.72v2.55c0 .23.16.51.62.42A9 9 0 0 0 12 3Z",
    box: "M4 7.5 12 3l8 4.5v9L12 21l-8-4.5zM4 7.5l8 4.5 8-4.5M12 12v9",
    server: "M4 5h16v5H4zM4 14h16v5H4zM7 7.5h.01M7 16.5h.01M10 7.5h7M10 16.5h7",
    settings: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm7.4 3.5a7.3 7.3 0 0 0-.08-1l2-1.55-2-3.46-2.35.95a7.4 7.4 0 0 0-1.72-1L14.9 3h-4l-.36 2.94a7.4 7.4 0 0 0-1.72 1l-2.35-.95-2 3.46 2 1.55a7.3 7.3 0 0 0 .08 2l-2 1.55 2 3.46 2.35-.95a7.4 7.4 0 0 0 1.72 1L10.9 21h4l.36-2.94a7.4 7.4 0 0 0 1.72-1l2.35.95 2-3.46-2-1.55a7.3 7.3 0 0 0-.07-1Z",
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="icon"><path d={paths[name] ?? paths.grid} /></svg>;
}

const themeKey = "developer-os-theme";

const emptySubscribe = () => () => {};
const clientTrue = () => true;
const serverFalse = () => false;

export const themeToggleEvent = "developer-os-toggle-theme";
export const commandPaletteEvent = "developer-os-open-command-palette";

// Which routed section a pathname belongs to. The shell lives in the root layout, so every route
// inherits it and no section needs its own layout file that could drift from the others.
const routeSections: { prefix: string; page: ShellNavId; title: string }[] = [
  { prefix: "/deployments", page: "deployments", title: "Deployments" },
  { prefix: "/servers", page: "servers", title: "Servers" },
  { prefix: "/projects", page: "projects", title: "Projects" },
  { prefix: "/github", page: "github", title: "GitHub" },
  { prefix: "/git", page: "git", title: "Git" },
  { prefix: "/terminal", page: "terminal", title: "Terminal" },
  { prefix: "/system", page: "system", title: "System" },
];

function sectionFor(pathname: string) {
  return routeSections.find((section) => pathname === section.prefix || pathname.startsWith(`${section.prefix}/`));
}

type AppShellProps = {
  /**
   * Nav item that should render as active. Omitted by routed pages, which derive it from the
   * pathname; the hash workspace passes its own live tab id.
   */
  page?: ShellNavId | string;
  /** Label shown in the topbar crumb after "Workspace /". Derived from the pathname when omitted. */
  title?: string;
  children: React.ReactNode;
  onNavigate?: () => void;
};

// The single Developer OS shell. The hash workspace and every routed section render through this
// component, so the sidebar, topbar, content area, and theme can never drift apart between them.
export function AppShell({ page, title, children }: AppShellProps) {
  const pathname = usePathname();
  const section = sectionFor(pathname);
  // "/" is the hash workspace, so its active nav item lives in the URL fragment; every other route
  // derives both its active item and its crumb from the pathname.
  const [hashPage, setHashPage] = useState(() => "");
  useEffect(() => {
    if (pathname !== "/") return;
    const sync = () => setHashPage(window.location.hash.slice(1) || "overview");
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [pathname]);
  const activePage = page ?? (hashPage || section?.page || "overview");
  const crumb = title ?? section?.title ?? activePage.replace(/-/g, " ").replace(/^./, (letter) => letter.toUpperCase());
  // On a routed section every other nav item must leave the section, or "#id" would only change the
  // fragment of the current route and the workspace tab would never open.
  const navHref = (id: string) => (section && id !== section.page ? `/#${id}` : section ? section.prefix : `#${id}`);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState("");
  // Read during the initial render instead of in an effect: no mount setState, and the stored theme
  // survives navigating between the shell's routes.
  const [dark, setDark] = useState(() => {
    if (typeof window === "undefined") return true;
    try { return window.localStorage.getItem(themeKey) !== "light"; } catch { return true; }
  });
  // SSR-safe client flag, so the toast never renders during hydration.
  const mounted = useSyncExternalStore(emptySubscribe, clientTrue, serverFalse);

  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const closeMenu = () => setMenuOpen(false);
  const notify = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(""), 2600); };
  const toggleTheme = useCallback(() => {
    setDark((current) => {
      const next = !current;
      try { window.localStorage.setItem(themeKey, next ? "dark" : "light"); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);

  // The command palette lives outside the shell, so it requests a theme change through this event.
  useEffect(() => {
    const listener = () => toggleTheme();
    window.addEventListener(themeToggleEvent, listener);
    return () => window.removeEventListener(themeToggleEvent, listener);
  }, [toggleTheme]);

  return <div className={dark ? "app-shell dark" : "app-shell"}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
      <div className="brand"><span className="brand-mark">D</span><span>Developer OS</span></div>
      <nav aria-label="Primary navigation">{navGroups.map((group) => <div className="nav-group" key={group.label}><div className="nav-label">{group.label}</div>{group.items.map(([label, id]) => <a className={activePage === id ? "nav-item active" : "nav-item"} aria-current={activePage === id ? "page" : undefined} href={navHref(id)} key={id} onClick={closeMenu}><Icon name={iconFor(id)} />{label}</a>)}</div>)}</nav>
      <div className="sidebar-bottom">
        <a className={activePage === "settings" ? "nav-item active" : "nav-item"} aria-current={activePage === "settings" ? "page" : undefined} href={navHref("settings")} onClick={closeMenu}><Icon name="settings" />Settings</a>
        <button className="profile-row" onClick={() => notify("Profile controls are not connected yet.")}><span className="avatar">SK</span><span><strong>Skywalker</strong><small>Local workspace</small></span><span className="more">•••</span></button>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="crumb"><button className="mobile-menu" aria-label="Open navigation" onClick={() => setMenuOpen(!menuOpen)}>☰</button><span>Workspace</span><span className="crumb-separator">/</span><strong>{crumb}</strong></div>
        <div className="top-actions">
          <button className="command-trigger" onClick={() => window.dispatchEvent(new CustomEvent(commandPaletteEvent))}><span>Search commands</span><kbd>⌘ K</kbd></button>
          <button className="icon-button" aria-label="View notifications" onClick={() => notify("No new notifications.")}>◌</button>
          <button className="icon-button" aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} onClick={toggleTheme}>{dark ? "☼" : "☾"}</button>
          <button className="top-avatar" aria-label="Open profile" onClick={() => notify("Profile controls are not connected yet.")}>SK</button>
        </div>
      </header>
      <main id="main-content" className="main-content">{children}</main>
    </div>
    {mounted && notice && <div className="toast" role="status">{notice}</div>}
  </div>;
}
