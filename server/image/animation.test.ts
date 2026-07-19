// Tests for animation helpers — no network. Fake sheets built with sharp;
// verify grid dimensions, frame count, prompt text, and AnimationStore I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createGrid, buildPrompt, sliceAndGif, AnimationStore } from "./animation.ts";

test("createGrid produces exact square-cell dimensions", async () => {
  const rows = 3;
  const cols = 4;
  const width = 400;
  const line = 2;
  const { png, w, h } = await createGrid(rows, cols, width, line);

  const cell = Math.floor((width - (cols + 1) * line) / cols);
  assert.equal(w, cols * cell + (cols + 1) * line);
  assert.equal(h, rows * cell + (rows + 1) * line);

  const meta = await sharp(png).metadata();
  assert.equal(meta.width, w);
  assert.equal(meta.height, h);
});

test("createGrid rejects out-of-range dimensions", async () => {
  await assert.rejects(() => createGrid(1, 3, 300), /between 2 and 6/);
  await assert.rejects(() => createGrid(3, 7, 300), /between 2 and 6/);
});

test("createGrid clamps odd/small line width to 2", async () => {
  const a = await createGrid(2, 2, 200, 3); // odd -> 2
  const b = await createGrid(2, 2, 200, 2);
  assert.equal(a.w, b.w);
  assert.equal(a.h, b.h);
});

test("sliceAndGif emits a GIF with rows*cols frames", async () => {
  const rows = 2;
  const cols = 3;
  const { png, w, h } = await createGrid(rows, cols, 300, 2);
  const gif = await sliceAndGif(png, rows, cols, { duration: 100 });

  // GIF magic header.
  assert.equal(gif.subarray(0, 6).toString("ascii"), "GIF89a");

  // Count image separators (0x2C) — one per frame.
  let frames = 0;
  for (let i = 0; i < gif.length; i++) {
    if (gif[i] === 0x2c) frames++;
  }
  assert.equal(frames, rows * cols);
  // Sheet dims were consumed; ensure we actually sliced a real sheet.
  assert.ok(w > 0 && h > 0);
});

test("sliceAndGif writes to outPath when provided", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anim-"));
  const outPath = join(dir, "nested", "preview.gif");
  const { png } = await createGrid(2, 2, 200, 2);
  const gif = await sliceAndGif(png, 2, 2, { outPath });
  assert.ok(existsSync(outPath));
  assert.deepEqual(readFileSync(outPath), gif);
});

test("sliceAndGif throws when the sheet is too small for the grid", async () => {
  const tiny = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .png()
    .toBuffer();
  await assert.rejects(() => sliceAndGif(tiny, 6, 6, {}), /too small/);
});

test("buildPrompt (new mode) contains base sprite-sheet phrasing", () => {
  const p = buildPrompt("running cat", 3, 4, { style: "pixel art" });
  assert.match(p, /Sprite sheet of a running cat illustration/);
  assert.match(p, /pixel art style/);
  assert.match(p, /3x4 grid \(3 rows and 4 columns\)/);
  assert.match(p, /white background, sequence, frame by frame animation, square aspect ratio\./);
  assert.match(p, /Create a new image by :/);
});

test("buildPrompt drops empty and 'None' modifiers", () => {
  const p = buildPrompt("jumping dog", 2, 2, { style: "None", era: "", color: "vibrant" });
  assert.doesNotMatch(p, /None style/);
  assert.doesNotMatch(p, /era/);
  assert.match(p, /vibrant colors/);
});

test("buildPrompt (continue mode) adds continuation context", () => {
  const p = buildPrompt("walk cycle", 2, 3, { mode: "continue", prevPromptContext: "idle stance" });
  assert.match(p, /continuing the animation sequence/);
  assert.match(p, /Previous Prompt Context: "idle stance"/);
  assert.match(p, /Current Prompt Context: "walk cycle"/);
  assert.match(p, /first row of the attached image contains the LAST frames/);
});

test("AnimationStore persists, updates, and reloads records", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  const store = new AnimationStore(dir);
  assert.equal(store.getLast(), undefined);

  const id = store.add({
    description: "run",
    prompt: "sprite sheet ...",
    grid_config: { rows: 2, cols: 3 },
    generation_mode: "new",
  });
  assert.equal(typeof id, "string");
  assert.equal(id.length, 12);

  const rec = store.get(id);
  assert.ok(rec);
  assert.equal(rec.status, "completed");
  assert.equal(typeof rec.timestamp, "string");
  assert.equal(store.getLast()?.id, id);

  store.update(id, { status: "failed", grid_config: { rows: 2, cols: 4 } });
  const updated = store.get(id);
  // Deep merge keeps rows, overrides cols.
  assert.equal(updated?.status, "failed");
  assert.deepEqual(updated?.grid_config, { rows: 2, cols: 4 });

  // A fresh store rooted at the same dir reloads from history.json.
  const reloaded = new AnimationStore(dir);
  assert.equal(reloaded.getLast()?.id, id);
  assert.equal(reloaded.get(id)?.status, "failed");
});

test("AnimationStore.update throws for unknown id", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  const store = new AnimationStore(dir);
  assert.throws(() => store.update("nope", { status: "x" }), /No record with id/);
});
