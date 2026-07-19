// Tests for triangulationMatting — no network. Fake white/black renders built
// with sharp; verify the output PNG carries a real alpha channel.
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { triangulationMatting } from "./matting.ts";

/** A solid WxH RGB PNG of the given colour. */
async function solid(width: number, height: number, r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r, g, b } } })
    .png()
    .toBuffer();
}

test("output PNG has an alpha channel and matching size", async () => {
  const white = await solid(8, 6, 255, 255, 255);
  const black = await solid(8, 6, 0, 0, 0);
  const out = await triangulationMatting(white, black);
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 8);
  assert.equal(meta.height, 6);
  assert.equal(meta.channels, 4);
  assert.equal(meta.hasAlpha, true);
});

test("identical white/black pixel is fully opaque (alpha=255)", async () => {
  // Same colour on both backgrounds => C_white - C_black = 0 => alpha = 1.
  const white = await solid(4, 4, 120, 130, 140);
  const black = await solid(4, 4, 120, 130, 140);
  const out = await triangulationMatting(white, black);
  const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  // First pixel alpha channel.
  assert.equal(data[3], 255);
});

test("white-on-white vs black background => transparent (alpha=0)", async () => {
  // Pure background: white render = 255, black render = 0 => alpha = 1-(1-0)=0.
  const white = await solid(4, 4, 255, 255, 255);
  const black = await solid(4, 4, 0, 0, 0);
  const out = await triangulationMatting(white, black);
  const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[3], 0);
});

test("resizes the black render to match the white render", async () => {
  const white = await solid(10, 10, 200, 200, 200);
  const black = await solid(5, 5, 200, 200, 200);
  const out = await triangulationMatting(white, black);
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 10);
  assert.equal(meta.height, 10);
});
