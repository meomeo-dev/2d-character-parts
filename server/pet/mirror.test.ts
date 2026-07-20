// Tests for mirrorFrames: horizontal flip that preserves frame order.
//
// We build frames whose opaque block sits in the LEFT half, mirror them, and
// assert the block moves to the RIGHT half while the count and per-frame index
// stay put (the mirror of running-right must line up phase-for-phase with
// running-left).
// Run: node --import tsx --test server/pet/mirror.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { mirrorFrames } from "./mirror.ts";

const W = 100;
const H = 40;

/** A W×H transparent frame with an opaque block in its left quarter. */
async function leftBlockFrame(): Promise<Buffer> {
  const block = await sharp({
    create: { width: 20, height: H, channels: 4, background: { r: 0, g: 180, b: 0, alpha: 255 } },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: block, left: 5, top: 0 }])
    .png()
    .toBuffer();
}

/** Count non-transparent pixels in the left vs right half of a frame. */
async function halfCounts(png: Buffer): Promise<{ left: number; right: number }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mid = Math.floor(info.width / 2);
  let left = 0;
  let right = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3]! !== 0) {
        if (x < mid) left++;
        else right++;
      }
    }
  }
  return { left, right };
}

test("mirrorFrames flips left-weighted frames to the right, preserving count and order", async () => {
  const src = [await leftBlockFrame(), await leftBlockFrame(), await leftBlockFrame()];

  // Sanity: sources are left-weighted.
  for (const f of src) {
    const { left, right } = await halfCounts(f);
    assert.ok(left > 0 && right === 0, "source block should sit entirely in the left half");
  }

  const out = await mirrorFrames(src);
  assert.equal(out.length, src.length, "frame count preserved");

  for (let i = 0; i < out.length; i++) {
    const meta = await sharp(out[i]!).metadata();
    assert.equal(meta.width, W);
    assert.equal(meta.height, H);
    const { left, right } = await halfCounts(out[i]!);
    assert.ok(right > 0 && left === 0, `mirrored frame ${i} block should sit entirely in the right half`);
  }
});

test("mirrorFrames on an empty array returns an empty array", async () => {
  assert.deepEqual(await mirrorFrames([]), []);
});
