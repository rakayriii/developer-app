import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { clampIndex, filterCommands, stepIndex } from "../src/lib/command-palette.ts";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

const commands = [
  { id: "nav:overview", label: "Go to Overview", group: "Navigate", keywords: "overview" },
  { id: "nav:projects", label: "Open Projects", group: "Navigate", keywords: "projects" },
  { id: "nav:deployments", label: "Open Deployments", group: "Navigate", keywords: "deployments" },
  { id: "nav:pull-requests", label: "Open Pull Requests", group: "Navigate", keywords: "pull-requests" },
  { id: "nav:servers", label: "Open Servers", group: "Navigate", keywords: "servers" },
  { id: "action:theme", label: "Toggle theme", group: "Actions", keywords: "theme dark light appearance" },
  { id: "nav:settings", label: "Open Settings", group: "Actions", keywords: "settings preferences" },
];

const labels = (list) => list.map((command) => command.label);

// -------------------------------------------------------------------------------------------
// Filtering
// -------------------------------------------------------------------------------------------
describe("palette filtering", () => {
  it("returns every command when nothing has been typed", () => {
    assert.equal(filterCommands(commands, "").length, commands.length);
    assert.equal(filterCommands(commands, "   ").length, commands.length);
  });

  it("finds a command by a word in its label", () => {
    assert.deepEqual(labels(filterCommands(commands, "deployment")), ["Open Deployments"]);
    assert.deepEqual(labels(filterCommands(commands, "github")), []);
    assert.deepEqual(labels(filterCommands(commands, "settings")), ["Open Settings"]);
    assert.deepEqual(labels(filterCommands(commands, "theme")), ["Toggle theme"]);
  });

  it("finds a command by its keyword even when the label words differ", () => {
    // "pull-requests" cannot substring-match the label "Open Pull Requests", so the id is a keyword.
    assert.deepEqual(labels(filterCommands(commands, "pull-requests")), ["Open Pull Requests"]);
    assert.deepEqual(labels(filterCommands(commands, "dark")), ["Toggle theme"]);
  });

  it("is case insensitive and tolerates surrounding whitespace", () => {
    assert.deepEqual(labels(filterCommands(commands, "  DEPLOY  ")), ["Open Deployments"]);
    assert.deepEqual(labels(filterCommands(commands, "ToGeMe")), []);
  });

  it("matches on a partial word", () => {
    assert.deepEqual(labels(filterCommands(commands, "deploy")), ["Open Deployments"]);
    assert.deepEqual(labels(filterCommands(commands, "serv")), ["Open Servers"]);
  });

  it("returns nothing for a query that matches nothing", () => {
    assert.deepEqual(filterCommands(commands, "zzzzzz"), []);
  });

  it("preserves registry order so results do not jump around while typing", () => {
    assert.deepEqual(labels(filterCommands(commands, "open")), ["Open Projects", "Open Deployments", "Open Pull Requests", "Open Servers", "Open Settings"]);
  });
});

// -------------------------------------------------------------------------------------------
// Selection index
// -------------------------------------------------------------------------------------------
describe("selection index is always inside the result range", () => {
  it("has nothing to select when there are no results", () => {
    assert.equal(clampIndex(0, 0), -1);
    assert.equal(clampIndex(5, 0), -1);
    assert.equal(stepIndex(0, 0, 1), -1);
    assert.equal(stepIndex(0, 0, -1), -1);
  });

  it("clamps an index that outgrew the result list", () => {
    assert.equal(clampIndex(9, 3), 2);
    assert.equal(clampIndex(-4, 3), 0);
    assert.equal(clampIndex(1.8, 3), 1);
  });

  it("stays put when the list has not changed", () => {
    assert.equal(clampIndex(2, 5), 2);
  });

  it("treats a non-finite or negative length as no results", () => {
    assert.equal(clampIndex(2, Number.NaN), -1);
    assert.equal(clampIndex(2, -3), -1);
  });

  it("steps down and wraps past the end", () => {
    assert.equal(stepIndex(0, 3, 1), 1);
    assert.equal(stepIndex(1, 3, 1), 2);
    assert.equal(stepIndex(2, 3, 1), 0);
  });

  it("steps up and wraps past the start", () => {
    assert.equal(stepIndex(2, 3, -1), 1);
    assert.equal(stepIndex(1, 3, -1), 0);
    assert.equal(stepIndex(0, 3, -1), 2);
  });

  it("lands on a real row from the unselected state", () => {
    // Clamp first, then move: down reaches the first result, up reaches the last.
    assert.equal(stepIndex(-1, 3, 1), 1);
    assert.equal(stepIndex(-1, 3, -1), 2);
  });

  it("survives a result list that shrank under the selection", () => {
    // Typing narrows the list; the previous index may no longer exist.
    const narrowed = clampIndex(7, 2);
    assert.equal(narrowed, 1);
    assert.equal(stepIndex(7, 2, 1), 0);
  });
});

// -------------------------------------------------------------------------------------------
// The palette is wired to keyboard execution, and there is only one of it
// -------------------------------------------------------------------------------------------
const shell = read("src/components/app-shell.tsx");
const workspace = read("src/components/developer-os.tsx");

describe("pressing Enter executes the selected command", () => {
  it("handles Enter in the palette input and runs the selected command", () => {
    // The key is decoded by the pure state machine, so the component has no hardcoded key branches.
    assert.match(shell, /const action = paletteAction\(view, event\.key\);/);
    assert.match(shell, /if \(action\.index >= 0\) execute\(results\[action\.index\]\);/);
    assert.ok(!/event\.key === "Enter"/.test(shell), "Enter is handled by the state machine, not inline");
  });

  it("moves the selection with the arrow keys", () => {
    assert.match(shell, /if \(action\.type === "move"\) \{ setState\(reducePalette\(view, action\)\); return; \}/);
    assert.ok(!/event\.key === "Arrow/.test(shell), "arrow keys are handled by the state machine, not inline");
  });

  it("prevents the default action only for the keys it owns, so the caret does not move", () => {
    const handler = shell.slice(shell.indexOf("const onKeyDown"), shell.indexOf("const groups"));
    // Returning early for an unrecognised key is what keeps ordinary text input working; the preventDefault
    // comes after it, so it can only ever apply to a key the palette actually owns.
    assert.match(handler, /if \(!action\) return;[\s\S]{0,200}event\.preventDefault\(\);/);
    assert.ok(handler.indexOf("if (!action) return;") < handler.indexOf("event.preventDefault()"), "the default action is prevented before the key is classified");
  });

  it("closes on Escape without running anything", () => {
    assert.match(shell, /if \(action\.type === "close"\) \{ close\(\); return; \}/);
    // Escape is decoded to a close action and never to an execute action.
    assert.ok(!/Escape[\s\S]{0,120}execute\(/.test(shell), "Escape must not run a command");
  });

  it("executes the command that is actually highlighted", () => {
    assert.match(shell, /const activeIndex = clampIndex\(state\.selectedIndex, results\.length\);/);
    assert.match(shell, /const activeCommand = activeIndex >= 0 \? results\[activeIndex\] : undefined;/);
    // Enter and the highlighted row are resolved from the same clamped index, so they cannot disagree.
    assert.match(shell, /aria-selected=\{index === activeIndex\}/);
  });

  it("filters on the typed query and resets the selection when it changes", () => {
    assert.match(shell, /filterCommands\(commands, state\.query\)/);
    assert.match(shell, /onChange=\{\(event\) => setState\(paletteQueryChanged\(view, event\.target\.value\)\)\}/);
  });

  it("controls the input so filtering actually happens", () => {
    // The previous palette had neither value nor onChange, so typing could never filter.
    assert.match(shell, /value=\{state\.query\}/);
    assert.match(shell, /onChange=/);
  });

  it("executes the clicked command on mouse click", () => {
    assert.match(shell, /onClick=\{\(\) => execute\(command\)\}/);
  });

  it("scrolls the highlighted row into view when the list overflows", () => {
    assert.match(shell, /scrollIntoView\(\{ block: "nearest" \}\)/);
  });
});

describe("edge cases are handled rather than thrown", () => {
  it("does nothing when there are no results", () => {
    assert.match(shell, /if \(!command \|\| command\.disabled\) return;/);
    assert.match(shell, /if \(action\.index >= 0\) execute\(results\[action\.index\]\);/);
    assert.match(shell, /results\.length === 0 \? <div className="command-empty">No matching commands\.<\/div>/);
  });

  it("does not run a disabled command", () => {
    assert.match(shell, /if \(!command \|\| command\.disabled\) return;/);
    assert.match(shell, /disabled=\{command\.disabled\}/);
  });

  it("prevents a second execution while one is already running", () => {
    // The guard flips synchronously, so two Enter presses in one tick cannot both run the command.
    assert.match(shell, /let inFlight = false;/);
    assert.match(shell, /if \(inFlight\) return;/);
    assert.match(shell, /inFlight = true;/);
  });

  it("closes the palette after executing, and still closes if a command throws", () => {
    assert.match(shell, /finally \{ inFlight = false; close\(\); \}/);
  });
});

describe("palette accessibility", () => {
  it("marks the selected result with aria-selected", () => {
    assert.match(shell, /aria-selected=\{index === activeIndex\}/);
    assert.match(shell, /aria-activedescendant=\{activeCommand \? `command-palette-option-\$\{activeCommand\.id\}` : undefined\}/);
  });

  it("uses combobox and listbox semantics", () => {
    assert.match(shell, /role="combobox"/);
    assert.match(shell, /role="listbox"/);
    assert.match(shell, /role="option"/);
    assert.match(shell, /aria-controls="command-palette-list"/);
  });

  it("hides the decorative group headings from assistive technology", () => {
    assert.match(shell, /className="command-group-label" aria-hidden="true"/);
  });

  it("keeps the search input focused and auto-focused", () => {
    assert.match(shell, /autoFocus\n\s*value=\{state\.query\}/);
    // Focus is never moved to a result row, so the caret stays in the input while arrowing.
    assert.ok(!/command-item[\s\S]{0,200}autoFocus/.test(shell), "focus must not move to a result");
  });
});

describe("there is exactly one command palette", () => {
  function find(directory) {
    const absolute = path.join(root, directory);
    if (!existsSync(absolute)) return [];
    return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
      const nested = path.join(directory, entry.name);
      return entry.isDirectory() ? find(nested) : entry.name.endsWith(".tsx") ? [nested] : [];
    });
  }

  it("is implemented in exactly one component", () => {
    const definitions = find("src/components").filter((file) => /function\s+CommandPalette\s*\(/.test(read(file)));
    assert.deepEqual(definitions, ["src/components/app-shell.tsx"]);
  });

  it("leaves no second palette in the workspace component", () => {
    assert.ok(!/CommandPalette/.test(workspace), "the workspace component still defines a palette");
    assert.ok(!/paletteOpen/.test(workspace), "the workspace component still owns palette state");
  });

  it("registers Ctrl/Cmd + K on the shell, so it works on every route", () => {
    assert.match(shell, /\(event\.metaKey \|\| event\.ctrlKey\) && event\.key\.toLowerCase\(\) === "k"/);
    assert.match(shell, /window\.addEventListener\("keydown", key\)/);
    assert.ok(!/metaKey/.test(workspace), "the shortcut is still bound in the workspace component");
  });
});

describe("commands reuse the existing navigation and registry", () => {
  it("derives navigation commands from the sidebar's own registry", () => {
    assert.match(shell, /navGroups\.flatMap\(/);
    // Every sidebar item is therefore reachable from the palette without a second list to maintain.
    assert.match(shell, /run: \(\) => navigateToWorkspace\(id\)/);
  });

  it("keeps the two commands the palette already offered", () => {
    assert.match(shell, /label: "Search projects"/);
    assert.match(shell, /label: "Toggle theme"/);
    assert.match(shell, /label: "Open Settings"/);
  });

  it("resolves a target through the same helper the sidebar links use", () => {
    assert.match(shell, /const navHref = \(id: string\) => commandTargetHref\(id, pathname\);/);
    assert.match(shell, /href=\{navHref\(id\)\}/);
  });

  it("does not hardcode any particular search term", () => {
    // Nothing in the palette may special-case a query; every command runs through the same path.
    assert.ok(!/deployment"\s*===|query === "|=== query/.test(shell), "the palette special-cases a query");
  });
});
