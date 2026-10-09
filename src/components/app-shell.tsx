"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { clampIndex, filterCommands, initialPaletteState, paletteAction, paletteQueryChanged, reducePalette, type PaletteState, type PaletteCommandLike } from "@/lib/command-palette";
import { commandTargetHref, navGroups, sectionFor, type ShellNavId } from "@/lib/navigation";

/** Navigates using the same target resolution as the sidebar, so routing is never duplicated here. */
export function navigateToWorkspace(id: string) {
  window.location.assign(commandTargetHref(id, window.location.pathname));
}

export type PaletteCommand = PaletteCommandLike & { group: string; run: () => void };

/**
 * The palette's command registry.
 *
 * Navigation entries are derived from `navGroups`, the sidebar's own registry, so a palette command can
 * never fall out of step with the navigation beside it. The commands the palette already offered are
 * preserved as explicit entries.
 */
export function buildPaletteCommands(toggleTheme: () => void): PaletteCommand[] {
  const navigation: PaletteCommand[] = navGroups.flatMap((group) => group.items.map(([label, id]) => ({
    id: `nav:${id}`,
    label: id === "overview" ? `Go to ${label}` : `Open ${label}`,
    group: "Navigate",
    keywords: id,
    run: () => navigateToWorkspace(id),
  })));

  navigation.push({ id: "search:projects", label: "Search projects", group: "Navigate", keywords: "projects search", run: () => navigateToWorkspace("projects") });

  return [
    ...navigation,
    { id: "action:theme", label: "Toggle theme", group: "Actions", keywords: "theme dark light appearance", run: toggleTheme },
    { id: "nav:settings", label: "Open Settings", group: "Actions", keywords: "settings preferences", run: () => navigateToWorkspace("settings") },
  ];
}

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

type AppShellProps = {
  /**
   * Nav item that should render as active. Omitted by routed pages, which derive it from the
   * pathname; the hash workspace passes its own live tab id.
   */
  page?: ShellNavId | string;
  /** Label shown in the topbar crumb after "Workspace /". Derived from the pathname when omitted. */
  title?: string;
  children: React.ReactNode;
};

/**
 * Guards against running the same command twice.
 *
 * This lives outside the component on purpose. The guard needs a value that flips synchronously, so it
 * cannot be state: two Enter presses in one tick would both read the same stale value. Declaring it here
 * as a plain closure keeps it out of the component's render scope, and its stable identity comes from a
 * lazy state initializer rather than a ref.
 */
function createExecutionGuard() {
  let inFlight = false;
  return {
    run(command: PaletteCommand, close: () => void) {
      if (inFlight) return;
      inFlight = true;
      try { command.run(); }
      catch (error) { console.error("Command palette command failed:", error); }
      finally { inFlight = false; close(); }
    },
  };
}

/**
 * The command palette. A single implementation, rendered by the shell on every route so Ctrl/Cmd + K and
 * the topbar trigger behave identically wherever the user is.
 */
function CommandPalette({ close, commands }: { close: () => void; commands: PaletteCommand[] }) {
  const [state, setState] = useState(initialPaletteState);
  const [guard] = useState(createExecutionGuard);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => filterCommands(commands, state.query), [commands, state.query]);
  // The visible result count is part of the state the key handlers reason about, so a keystroke always
  // clamps against the list the user can actually see rather than the one they saw a moment ago.
  const view: PaletteState = { ...state, resultsLength: results.length };
  const activeIndex = clampIndex(state.selectedIndex, results.length);
  const activeCommand = activeIndex >= 0 ? results[activeIndex] : undefined;

  function execute(command: PaletteCommand | undefined) {
    // A disabled command, or an empty result list, is a no-op: nothing to run, nothing to close over.
    if (!command || command.disabled) return;
    guard.run(command, close);
  }

  // Keep the highlighted row visible when the list is longer than the viewport.
  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, state.query]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const action = paletteAction(view, event.key);
    // An unrecognised key is left entirely alone, so ordinary typing is never interrupted.
    if (!action) return;
    // Only the four keys the palette owns reach here, and all four must not act on the browser default:
    // the arrows would move the text caret, Enter would submit nothing useful.
    event.preventDefault();
    if (action.type === "close") { close(); return; }
    if (action.type === "move") { setState(reducePalette(view, action)); return; }
    if (action.index >= 0) execute(results[action.index]);
  };

  // Group headings are decoration only; the listbox below is what assistive technology reads.
  const groups: string[] = [...new Set(results.map((command) => command.group))];

  return <div className="palette-backdrop" role="presentation" onMouseDown={close}><section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()}>
    <div className="palette-input">
      <span aria-hidden="true">⌕</span>
      <input
        autoFocus
        value={state.query}
        onChange={(event) => setState(paletteQueryChanged(view, event.target.value))}
        onKeyDown={onKeyDown}
        placeholder="Type a command..."
        aria-label="Search commands"
        role="combobox"
        aria-expanded="true"
        aria-controls="command-palette-list"
        aria-autocomplete="list"
        aria-activedescendant={activeCommand ? `command-palette-option-${activeCommand.id}` : undefined}
      />
    </div>
    <div className="command-list" id="command-palette-list" role="listbox" aria-label="Commands" ref={listRef}>
      {results.length === 0 ? <div className="command-empty">No matching commands.</div> : groups.map((group) => <div key={group}>
        <div className="command-group-label" aria-hidden="true">{group}</div>
        {results.map((command, index) => (
          <button
            className="command-item"
            type="button"
            role="option"
            id={`command-palette-option-${command.id}`}
            key={command.id}
            aria-selected={index === activeIndex}
            disabled={command.disabled}
            onMouseMove={() => setState((current) => ({ ...current, selectedIndex: index }))}
            onClick={() => execute(command)}
          >
            <span>{command.label}</span>
            <kbd aria-hidden="true">↵</kbd>
          </button>
        ))}
      </div>)}
    </div>
    <div className="palette-footer"><span>Esc to close</span><span>↑↓ to navigate</span><span>↵ to run</span></div>
  </section></div>;
}

// The single Developer OS shell. The hash workspace and every routed section render through this
// component, so the sidebar, topbar, content area, theme, and command palette can never drift apart.
export function AppShell({ page, title, children }: AppShellProps) {
  const pathname = usePathname();
  const section = sectionFor(pathname);
  // "/" is the hash workspace, so its active nav item lives in the URL fragment; every other route
  // derives both its active item and its crumb from the pathname.
  const [hashPage, setHashPage] = useState("");
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
  const navHref = (id: string) => commandTargetHref(id, pathname);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notice, setNotice] = useState("");
  // Read during the initial render instead of in an effect: no mount setState, and the stored theme
  // survives navigating between the shell's routes.
  const [dark, setDark] = useState(() => {
    if (typeof window === "undefined") return true;
    try { return window.localStorage.getItem(themeKey) !== "light"; } catch { return true; }
  });
  // SSR-safe client flag, so the toast never renders during hydration.
  const mounted = useSyncExternalStore(emptySubscribe, clientTrue, serverFalse);

  const closeMenu = () => setMenuOpen(false);
  const notify = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(""), 2600); };
  const toggleTheme = useCallback(() => {
    setDark((current) => {
      const next = !current;
      try { window.localStorage.setItem(themeKey, next ? "dark" : "light"); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);

  const commands = useMemo(() => buildPaletteCommands(toggleTheme), [toggleTheme]);

  // Ctrl/Cmd + K opens the palette, Escape closes it. Registered on the shell so it works on every
  // route rather than only on the hash workspace.
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen(true); }
      if (event.key === "Escape") { setPaletteOpen(false); setMenuOpen(false); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

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
          <button className="command-trigger" onClick={() => setPaletteOpen(true)}><span>Search commands</span><kbd>⌘ K</kbd></button>
          <button className="icon-button" aria-label="View notifications" onClick={() => notify("No new notifications.")}>◌</button>
          <button className="icon-button" aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} onClick={toggleTheme}>{dark ? "☼" : "☾"}</button>
          <button className="top-avatar" aria-label="Open profile" onClick={() => notify("Profile controls are not connected yet.")}>SK</button>
        </div>
      </header>
      <main id="main-content" className="main-content">{children}</main>
    </div>
    {paletteOpen && <CommandPalette close={() => setPaletteOpen(false)} commands={commands} />}
    {mounted && notice && <div className="toast" role="status">{notice}</div>}
  </div>;
}
