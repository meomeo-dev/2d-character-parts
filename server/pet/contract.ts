// Codex desktop-pet atlas contract — the single source of truth for the fixed
// spritesheet geometry and per-row frame counts.
//
// The Codex pet atlas is a rigid 8×9 grid of 192×208 cells. Every downstream
// module (compose, validate, inspect) derives its layout from the constants and
// ROW_SPECS declared here, so there is exactly one place to change if the spec
// ever moves. Ported from the hatch-pet Python scripts, which hard-coded the
// same numbers in three separate files — we centralise them instead.

/** Number of columns (frame slots) per atlas row. */
export const COLUMNS = 8;
/** Number of rows (animation states) in the atlas. */
export const ROWS = 9;
/** Width of a single cell / frame, in pixels. */
export const CELL_WIDTH = 192;
/** Height of a single cell / frame, in pixels. */
export const CELL_HEIGHT = 208;
/** Full atlas width (COLUMNS × CELL_WIDTH = 1536). */
export const ATLAS_WIDTH = COLUMNS * CELL_WIDTH;
/** Full atlas height (ROWS × CELL_HEIGHT = 1872). */
export const ATLAS_HEIGHT = ROWS * CELL_HEIGHT;

/** One animation state's placement in the atlas. */
export interface RowSpec {
  /** State name (e.g. "idle", "running-right"). */
  state: string;
  /** Zero-based atlas row this state occupies. */
  row: number;
  /** Number of leading columns that hold real frames; the rest stay transparent. */
  usedCols: number;
}

// Ordered by row index (0..8). The order is load-bearing: consumers iterate
// ROW_SPECS to walk the atlas top-to-bottom. usedCols must never exceed COLUMNS.
export const ROW_SPECS: readonly RowSpec[] = [
  { state: "idle", row: 0, usedCols: 6 },
  { state: "running-right", row: 1, usedCols: 8 },
  { state: "running-left", row: 2, usedCols: 8 },
  { state: "waving", row: 3, usedCols: 4 },
  { state: "jumping", row: 4, usedCols: 5 },
  { state: "failed", row: 5, usedCols: 8 },
  { state: "waiting", row: 6, usedCols: 6 },
  { state: "running", row: 7, usedCols: 6 },
  { state: "review", row: 8, usedCols: 6 },
];

// Fast state → spec lookup, built once from the ordered list above.
export const rowSpecByState: ReadonlyMap<string, RowSpec> = new Map(
  ROW_SPECS.map((spec) => [spec.state, spec]),
);

/**
 * Return the used-column count for a state, or throw if the state is unknown.
 * Throwing (rather than returning 0) surfaces typos at the call site instead of
 * silently composing an all-transparent row.
 */
export function usedColsFor(state: string): number {
  const spec = rowSpecByState.get(state);
  if (!spec) {
    throw new Error(`unknown pet state "${state}"; expected one of ${ROW_SPECS.map((s) => s.state).join(", ")}`);
  }
  return spec.usedCols;
}
