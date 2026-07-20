// Tests for inspectFrames — no network. Mock frames built with sharp exercise
// the frame-count, emptiness, and edge-bleed checks for a single state's row.
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { inspectFrames } from "./inspect-frames.ts";
import { CELL_HEIGHT, CELL_WIDTH, usedColsFor } from "./contract.ts";

/** A normal frame: an opaque block centred with a healthy transparent margin. */
async function normalFrame(w = 120, h = 140): Promise<Buffer> {
  const block = await sharp({
    create: { width: w, height: h, channels: 4, background: { r: 200, g: 80, b: 40, alpha: 1 } },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: CELL_WIDTH, height: CELL_HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: block, left: Math.floor((CELL_WIDTH - w) / 2), top: Math.floor((CELL_HEIGHT - h) / 2) }])
    .png()
    .toBuffer();
}

/** A fully transparent (empty) frame at cell size. */
async function emptyFrame(): Promise<Buffer> {
  return sharp({
    create: { width: CELL_WIDTH, height: CELL_HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
}

/** A frame whose subject fills the whole cell, so its edge band is dense. */
async function edgeBleedFrame(): Promise<Buffer> {
  return sharp({
    create: { width: CELL_WIDTH, height: CELL_HEIGHT, channels: 4, background: { r: 10, g: 200, b: 90, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

test("(a) a correct count of normal frames inspects ok", async () => {
  const count = usedColsFor("idle"); // 6
  const frames = await Promise.all(Array.from({ length: count }, () => normalFrame()));
  const result = await inspectFrames(frames, "idle");
  assert.equal(result.ok, true, `unexpected errors: ${result.errors.join("; ")}`);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.frames.length, count);
});

test("(b) the wrong frame count is an error", async () => {
  const frames = await Promise.all(Array.from({ length: 3 }, () => normalFrame())); // idle needs 6
  const result = await inspectFrames(frames, "idle");
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /expected 6 frame files for idle, found 3/.test(e)));
});

test("(c) an empty frame is an error", async () => {
  const count = usedColsFor("waving"); // 4
  const frames = await Promise.all([
    emptyFrame(),
    ...Array.from({ length: count - 1 }, () => normalFrame()),
  ]);
  const result = await inspectFrames(frames, "waving");
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /waving frame 00 is empty or too sparse/.test(e)));
});

test("(d) a frame bleeding into the cell edge is a warning, not an error", async () => {
  const count = usedColsFor("jumping"); // 5
  const frames = await Promise.all([
    edgeBleedFrame(),
    ...Array.from({ length: count - 1 }, () => normalFrame()),
  ]);
  const result = await inspectFrames(frames, "jumping");
  assert.ok(result.warnings.some((w) => /frame 00 has .* pixels near the cell edge/.test(w)));
});

test("wrong-sized frames are an error", async () => {
  const count = usedColsFor("review"); // 6
  const small = await normalFrame(); // will be re-sized below to a wrong size
  const wrongSize = await sharp(small).resize(100, 100, { fit: "fill" }).png().toBuffer();
  const frames = [wrongSize, ...(await Promise.all(Array.from({ length: count - 1 }, () => normalFrame())))];
  const result = await inspectFrames(frames, "review");
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /review frame 00 is 100x100; expected 192x208/.test(e)));
});

test("inspectFrames throws on an unknown state", async () => {
  await assert.rejects(() => inspectFrames([], "flying"), /unknown pet state/);
});
