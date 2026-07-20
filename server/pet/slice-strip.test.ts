// Tests for sliceStrip: cut a horizontal transparent strip into fixed cells.
//
// We synthesize a real 3-frame strip (each frame a centred opaque block on a
// transparent background) with sharp, then assert the slicer returns 3 frames,
// each exactly 192×208, each carrying non-transparent pixels.
// Run: node --import tsx --test server/pet/slice-strip.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { CELL_HEIGHT, CELL_WIDTH } from "./contract.ts";
import { sliceStrip } from "./slice-strip.ts";

/** Count non-transparent (alpha != 0) pixels in a PNG buffer. */
async function nonTransparent(png: Buffer): Promise<number> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let p = 3; p < data.length; p += 4) {
    if (data[p]! !== 0) count++;
  }
  return count;
}

/**
 * Build a `frames`-wide horizontal strip on a transparent background, each slot
 * holding one centred opaque block. Slot width defaults to the atlas cell width
 * so the geometry mirrors a real generated row.
 */
async function makeStrip(frames: number, slotW = CELL_WIDTH, slotH = CELL_HEIGHT): Promise<Buffer> {
  const block = await sharp({
    create: { width: 60, height: 80, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 255 } },
  })
    .png()
    .toBuffer();

  const composites = Array.from({ length: frames }, (_, i) => ({
    input: block,
    left: i * slotW + Math.floor((slotW - 60) / 2),
    top: Math.floor((slotH - 80) / 2),
  }));

  return sharp({
    create: { width: frames * slotW, height: slotH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

test("sliceStrip cuts a 3-frame strip into three 192×208 transparent frames", async () => {
  const strip = await makeStrip(3);
  const frames = await sliceStrip(strip, 3);

  assert.equal(frames.length, 3);
  for (const frame of frames) {
    const meta = await sharp(frame).metadata();
    assert.equal(meta.width, CELL_WIDTH);
    assert.equal(meta.height, CELL_HEIGHT);
    assert.ok(meta.hasAlpha, "frame should keep an alpha channel");
    assert.ok((await nonTransparent(frame)) > 0, "frame should carry non-transparent pixels");
  }
});

test("sliceStrip handles a strip whose width is not an exact multiple of frameCount", async () => {
  // 200px-wide slots => 3 frames span 600px; add 5 stray px so width=605 and the
  // last segment must be clamped rather than reading past the right edge.
  const base = await makeStrip(3, 200, CELL_HEIGHT);
  const strip = await sharp(base)
    .extend({ right: 5, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const frames = await sliceStrip(strip, 3);
  assert.equal(frames.length, 3);
  for (const frame of frames) {
    const meta = await sharp(frame).metadata();
    assert.equal(meta.width, CELL_WIDTH);
    assert.equal(meta.height, CELL_HEIGHT);
    assert.ok((await nonTransparent(frame)) > 0);
  }
});

test("sliceStrip rejects a non-positive frameCount", async () => {
  const strip = await makeStrip(1);
  await assert.rejects(() => sliceStrip(strip, 0), /positive integer/);
  await assert.rejects(() => sliceStrip(strip, -2), /positive integer/);
});
