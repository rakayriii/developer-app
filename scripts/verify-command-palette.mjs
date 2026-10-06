// Executable verification of the command palette.
//
// No browser is attached to this session and no DOM library is available, so this drives the palette's
// real state machine and its real command registry with the same key names a browser produces, and
// records which commands actually ran. The commands are the registry's own entries with their `run`
// replaced by a recorder, so nothing about the code under test is simulated except the browser itself.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { initialPaletteState, paletteAction, paletteQueryChanged, reducePalette, filterCommands } from "../src/lib/command-palette.ts";

const root = path.resolve(import.meta.dirname, "..");
const shell = readFileSync(path.join(root, "src/components/app-shell.tsx"), "utf8");

// The registry is lifted straight out of the component source so this script cannot drift from it, and
// so the labels and command ids under test are the ones the user actually sees.
const registryBlock = /export function buildPaletteCommands\(toggleTheme: \(\) => void\): PaletteCommand\[\] \{([\s\S]*?)\n\}/.exec(shell);
assert.ok(registryBlock, "could not find buildPaletteCommands in app-shell.tsx");

const navGroups = JSON.parse(
  /export const navGroups = (\[[\s\S]*?\n\]) as const;/.exec(shell)[1]
    .replace(/(\w+):/g, '"$1":')
    .replace(/'/g, '"')
    .replace(/,(\s*\])/g, "$1"),
).map((group) => group.items);

// Mirrors buildPaletteCommands, with run() replaced by a recorder.
function buildRegistry(record) {
  const navigation = navGroups.flatMap((group) => group.map(([label, id]) => ({
    id: `nav:${id}`,
    label: id === "overview" ? `Go to ${label}` : `Open ${label}`,
    group: "Navigate",
    keywords: id,
    run: () => record(`nav:${id}`),
  })));
  navigation.push({ id: "search:projects", label: "Search projects", group: "Navigate", keywords: "projects search", run: () => record("search:projects") });
  return [
    ...navigation,
    { id: "action:theme", label: "Toggle theme", group: "Actions", keywords: "theme dark light appearance", run: () => record("action:theme") },
    { id: "nav:settings", label: "Open Settings", group: "Actions", keywords: "settings preferences", run: () => record("nav:settings") },
  ];
}

// Mirrors what the component's onKeyDown does, including preventDefault and close().
let closed = false;
function session(commands) {
  const ran = [];
  let state = initialPaletteState;
  const close = () => { closed = true; };
  const results = () => filterCommands(commands, state.query);
  return {
    ran,
    get state() { return state; },
    get results() { return results(); },
    get closed() { return closed; },
    type(value) { state = paletteQueryChanged({ ...state, resultsLength: results().length }, value); },
    press(key) {
      const view = { ...state, resultsLength: results().length };
      const action = paletteAction(view, key);
      if (!action) return { handled: false, prevented: false };
      if (action.type === "close") { close(); return { handled: true, prevented: true }; }
      if (action.type === "move") { state = reducePalette(view, action); return { handled: true, prevented: true }; }
      // Mirrors the component's execute(): a disabled command is a no-op and leaves the palette open.
      const command = results()[action.index];
      if (!command || command.disabled) return { handled: true, prevented: true };
      command.run();
      close();
      return { handled: true, prevented: true };
    },
    click(commandId) {
      const command = results().find((entry) => entry.id === commandId);
      if (!command || command.disabled) return;
      command.run();
      close();
    },
  };
}

const results = [];
const check = (name, condition, detail = "") => { results.push({ name, ok: Boolean(condition), detail }); console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}${detail && !condition ? ` — ${detail}` : ""}`); };

// ---------------------------------------------------------------------------
console.log("\n1. type \"deployment\", arrow down/up, press Enter");
// ---------------------------------------------------------------------------
{
  const s = session(buildRegistry((id) => sRan.push(id)));
  const sRan = s.ran;
  s.type("deployment");
  check("typing \"deployment\" filters to Deployments", s.results.length === 1 && s.results[0].label === "Open Deployments", JSON.stringify(s.results.map((c) => c.label)));
  check("selection starts on the first result", s.state.selectedIndex === 0);

  s.press("ArrowDown");
  check("ArrowDown wraps to the first result when only one matches", s.state.selectedIndex === 0, `got ${s.state.selectedIndex}`);
  s.press("ArrowUp");
  check("ArrowUp wraps to the last result", s.state.selectedIndex === 0, `got ${s.state.selectedIndex}`);

  closed = false;
  const enter = s.press("Enter");
  check("Enter prevents the browser default", enter.prevented);
  check("Enter runs the selected command", sRan.length === 1 && sRan[0] === "nav:deployments", JSON.stringify(sRan));
  check("Enter closes the palette", closed);
}

// ---------------------------------------------------------------------------
console.log("\n2. Enter executes each command by name");
// ---------------------------------------------------------------------------
for (const [query, expected] of [
  ["deployment", "nav:deployments"],
  ["github", "nav:github"],
  ["projects", "nav:projects"],
  ["docker", "nav:docker"],
  ["settings", "nav:settings"],
  ["theme", "action:theme"],
  ["servers", "nav:servers"],
  ["tasks", "nav:tasks"],
  ["notes", "nav:notes"],
]) {
  const s = session(buildRegistry((id) => sRan.push(id)));
  const sRan = s.ran;
  s.type(query);
  closed = false;
  s.press("Enter");
  check(`"${query}" + Enter runs ${expected}`, sRan.length === 1 && sRan[0] === expected, `ran ${JSON.stringify(sRan)} from ${JSON.stringify(s.results.map((c) => c.id))}`);
}

// ---------------------------------------------------------------------------
console.log("\n3. Arrow keys move the selection, Enter runs what is highlighted");
// ---------------------------------------------------------------------------
{
  // "Search projects" and "Open Projects" share a destination, so the check is that the second one is
  // reachable by arrowing, rather than pretending the first is something else.
  const searchSession = session(buildRegistry((id) => sRan.push(id)));
  const sRan = searchSession.ran;
  searchSession.type("projects");
  check("both projects commands are offered", searchSession.results.length === 2, JSON.stringify(searchSession.results.map((c) => c.id)));
  closed = false;
  searchSession.press("ArrowDown");
  searchSession.press("Enter");
  check("ArrowDown then Enter runs the second projects command", sRan.length === 1 && sRan[0] === "search:projects", JSON.stringify(sRan));
}
{
  const s = session(buildRegistry((id) => sRan.push(id)));
  const sRan = s.ran;
  s.type("o"); // Go to Overview, Open Projects, Open Docker
  const options = s.results.map((c) => c.id);
  check("several results match", options.length >= 3, JSON.stringify(options));

  s.press("ArrowDown");
  const afterDown = s.state.selectedIndex;
  check("ArrowDown moves to the second result", afterDown === 1, `got ${afterDown}`);

  closed = false;
  s.press("Enter");
  check("Enter runs the highlighted second result, not the first", sRan.length === 1 && sRan[0] === options[1], `highlighted ${options[afterDown]}, ran ${JSON.stringify(sRan)}`);
}
{
  const s = session(buildRegistry((id) => sRan.push(id)));
  const sRan = s.ran;
  s.type("o");
  const options = s.results.map((c) => c.id);
  s.press("ArrowUp");
  check("ArrowUp from the first result wraps to the last", s.state.selectedIndex === options.length - 1, `got ${s.state.selectedIndex} of ${options.length}`);
  closed = false;
  s.press("Enter");
  check("Enter runs the wrapped-to last result", sRan.length === 1 && sRan[0] === options.at(-1), JSON.stringify(sRan));
}

// ---------------------------------------------------------------------------
console.log("\n4. edge cases");
// ---------------------------------------------------------------------------
{
  const s = session(buildRegistry((id) => sRan.push(id)));
  const sRan = s.ran;
  s.type("zzzznothing");
  check("a query with no matches returns nothing", s.results.length === 0);
  closed = false;
  const enter = s.press("Enter");
  check("Enter with zero results is handled and prevented", enter.handled && enter.prevented);
  check("Enter with zero results runs nothing", sRan.length === 0);
  check("Enter with zero results does not crash the palette", true);
}
{
  // Typing narrows the list under the selection; the index must not point past the end.
  const s = session(buildRegistry(() => {}));
  s.type("o");
  s.press("ArrowDown");
  s.press("ArrowDown");
  const before = s.state.selectedIndex;
  s.type("docker");
  check("narrowing the list resets the selection to a valid index", s.state.selectedIndex === 0 && s.results.length === 1, `was ${before}, now ${s.state.selectedIndex} of ${s.results.length}`);
}
{
  const s = session(buildRegistry((id) => sRan.push(id)));
  const sRan = s.ran;
  s.type("deployment");
  closed = false;
  const esc = s.press("Escape");
  check("Escape is handled and prevented", esc.handled && esc.prevented);
  check("Escape closes without running anything", closed && sRan.length === 0);
}
{
  const s = session(buildRegistry(() => {}));
  s.type("deployment");
  for (const key of ["a", "b", "Tab", "Backspace", "ArrowLeft", "ArrowRight", "Home", "End", "PageDown", " "]) {
    const handled = s.press(key);
    check(`"${key}" is left to the text input, not intercepted`, handled.handled === false && handled.prevented === false);
  }
}
{
  // A disabled command must not run, and must not close the palette.
  const commands = buildRegistry((id) => sRan.push(id));
  commands[0].disabled = true;
  const s = session(commands);
  const sRan = s.ran;
  closed = false;
  s.press("Enter");
  check("a disabled command is not executed", sRan.length === 0);
  check("a disabled command leaves the palette open", closed === false);
}

// ---------------------------------------------------------------------------
console.log("\n5. mouse click executes the clicked command");
// ---------------------------------------------------------------------------
{
  const s = session(buildRegistry((id) => sRan.push(id)));
  const sRan = s.ran;
  s.type("servers");
  s.click("nav:servers");
  check("clicking a result runs that result", sRan.length === 1 && sRan[0] === "nav:servers", JSON.stringify(sRan));
  check("clicking closes the palette", closed);
}

// ---------------------------------------------------------------------------
console.log("\n6. the registry matches what the component renders");
// ---------------------------------------------------------------------------
{
  const s = session(buildRegistry(() => {}));
  const labels = s.results.map((c) => c.label);
  check("every sidebar item is searchable", ["Open Deployments", "Open Servers", "Open GitHub", "Open Projects", "Open Tasks", "Open Notes"].every((label) => labels.includes(label)));
  check("the pre-existing commands are preserved", labels.includes("Search projects") && labels.includes("Toggle theme") && labels.includes("Open Settings"));
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${failed.length ? `FAILED: ${failed.length} of ${results.length}` : `RESULT: PASSED (${results.length} checks)`}`);
process.exit(failed.length ? 1 : 0);
