// Tests for the atlas contract — geometry constants and ROW_SPECS self-consistency.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATLAS_HEIGHT,
  ATLAS_WIDTH,
  CELL_HEIGHT,
  CELL_WIDTH,
  COLUMNS,
  ROWS,
  ROW_SPECS,
  rowSpecByState,
  usedColsFor,
} from "./contract.ts";

test("atlas dimensions derive from the grid geometry", () => {
  assert.equal(COLUMNS, 8);
  assert.equal(ROWS, 9);
  assert.equal(CELL_WIDTH, 192);
  assert.equal(CELL_HEIGHT, 208);
  assert.equal(ATLAS_WIDTH, 1536);
  assert.equal(ATLAS_HEIGHT, 1872);
  assert.equal(ATLAS_WIDTH, COLUMNS * CELL_WIDTH);
  assert.equal(ATLAS_HEIGHT, ROWS * CELL_HEIGHT);
});

test("ROW_SPECS has one ordered entry per row with valid usedCols", () => {
  assert.equal(ROW_SPECS.length, ROWS);
  ROW_SPECS.forEach((spec, index) => {
    assert.equal(spec.row, index, `row ${index} out of order`);
    assert.ok(spec.usedCols >= 1 && spec.usedCols <= COLUMNS, `${spec.state} usedCols in range`);
  });
});

test("ROW_SPECS matches the fixed Codex layout", () => {
  assert.deepEqual(
    ROW_SPECS.map((s) => [s.state, s.row, s.usedCols]),
    [
      ["idle", 0, 6],
      ["running-right", 1, 8],
      ["running-left", 2, 8],
      ["waving", 3, 4],
      ["jumping", 4, 5],
      ["failed", 5, 8],
      ["waiting", 6, 6],
      ["running", 7, 6],
      ["review", 8, 6],
    ],
  );
});

test("total used frame count across all rows is 57", () => {
  const total = ROW_SPECS.reduce((sum, s) => sum + s.usedCols, 0);
  assert.equal(total, 6 + 8 + 8 + 4 + 5 + 8 + 6 + 6 + 6);
  assert.equal(total, 57);
});

test("rowSpecByState and usedColsFor agree with ROW_SPECS", () => {
  assert.equal(rowSpecByState.size, ROW_SPECS.length);
  for (const spec of ROW_SPECS) {
    assert.equal(rowSpecByState.get(spec.state), spec);
    assert.equal(usedColsFor(spec.state), spec.usedCols);
  }
});

test("usedColsFor throws on an unknown state", () => {
  assert.throws(() => usedColsFor("dancing"), /unknown pet state/);
});
