// Command palette logic, kept pure and free of React so the filtering and selection rules can be
// unit tested directly rather than through the DOM.

export type PaletteCommandLike = {
  id: string;
  label: string;
  group: string;
  /** Extra terms that should match this command, such as the workspace id behind its label. */
  keywords?: string;
  disabled?: boolean;
};

/**
 * Filters commands by a free-text query.
 *
 * A command matches when the query appears in its label or in any of its keywords, case-insensitively.
 * The workspace id is registered as a keyword so "pull-requests" finds "Open Pull Requests" and
 * "deploy" finds "Open Deployments", rather than only matching what is spelled out in the label.
 *
 * An empty query returns every command, which is what a palette should show before anything is typed.
 */
export function filterCommands<T extends PaletteCommandLike>(commands: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...commands];
  return commands.filter((command) => {
    if (command.label.toLowerCase().includes(needle)) return true;
    return (command.keywords ?? "").toLowerCase().split(/\s+/).some((term) => term.length > 0 && term.includes(needle));
  });
}

/**
 * Clamps a selection index into the current result range.
 *
 * Returns -1 when there is nothing to select, so "zero results" cannot produce an out-of-range index
 * that later indexes into an empty array.
 */
export function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(length) || length <= 0) return -1;
  const integer = Math.trunc(index);
  if (!Number.isFinite(integer)) return 0;
  return Math.min(Math.max(integer, 0), length - 1);
}

/**
 * Moves the selection by one, wrapping around both ends.
 *
 * Wrapping is what makes a palette feel right at the boundaries: arrowing down past the last result
 * returns to the first rather than sticking, and the same applies upward.
 *
 * From an unselected state, stepping down lands on the first result and stepping up lands on the last,
 * which follows from clamping first and then moving.
 */
export function stepIndex(index: number, length: number, delta: 1 | -1): number {
  if (!Number.isFinite(length) || length <= 0) return -1;
  const current = clampIndex(index, length);
  return (current + delta + length) % length;
}

/** The keys the palette owns. Anything else is left to the text input. */
export const paletteKeys = ["ArrowDown", "ArrowUp", "Enter", "Escape"] as const;
export type PaletteKey = (typeof paletteKeys)[number];

export type PaletteState = { query: string; selectedIndex: number; resultsLength: number };

export const initialPaletteState: PaletteState = { query: "", selectedIndex: 0, resultsLength: 0 };

/**
 * What a keystroke means to the palette.
 *
 * Returning null for every other key is deliberate: a palette that swallowed unrecognised keys would
 * break ordinary typing. Only the four keys it owns produce an action, and the caller calls
 * `preventDefault` for exactly those.
 */
export type PaletteAction =
  | { type: "move"; selectedIndex: number }
  | { type: "execute"; index: number }
  | { type: "close" }
  | null;

export function paletteAction(state: PaletteState, key: string): PaletteAction {
  if (!paletteKeys.includes(key as PaletteKey)) return null;
  if (key === "ArrowDown") return { type: "move", selectedIndex: stepIndex(state.selectedIndex, state.resultsLength, 1) };
  if (key === "ArrowUp") return { type: "move", selectedIndex: stepIndex(state.selectedIndex, state.resultsLength, -1) };
  if (key === "Escape") return { type: "close" };
  // Enter runs whatever is highlighted. With no results there is nothing to run, which is reported as
  // index -1 rather than indexing into an empty array.
  return { type: "execute", index: state.resultsLength > 0 ? clampIndex(state.selectedIndex, state.resultsLength) : -1 };
}

/** Applies an action, or returns the state unchanged when the action is null or inert. */
export function reducePalette(state: PaletteState, action: PaletteAction): PaletteState {
  if (!action) return state;
  if (action.type === "move") return { ...state, selectedIndex: clampIndex(action.selectedIndex, state.resultsLength) };
  return state;
}

/** Typing resets the selection, so a narrowed list always starts at its first result. */
export function paletteQueryChanged(state: PaletteState, value: string): PaletteState {
  return { ...state, query: value, selectedIndex: 0 };
}

