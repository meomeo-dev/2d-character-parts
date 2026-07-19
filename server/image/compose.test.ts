// Tests for composeParts — no network. Part PNGs written to a temp dir and
// composited onto a transparent canvas per a small layout config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { composeParts } from "./compose.ts";

async function solidPng(width: number, height: number, r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r, g, b, alpha: 1 } } })
    .png()
    .toBuffer();
}

test("composeParts places present parts and skips missing ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "parts-"));
  writeFileSync(join(dir, "head.png"), await solidPng(20, 20, 255, 0, 0));
  // "torso" intentionally missing — should be skipped, not error.

  const config = {
    meta: { canvas_width: 60, canvas_height: 60 },
    groups: [
      {
        id: "body",
        parts: [
          { id: "head", x: 5, y: 5, w: 10, h: 10 },
          { id: "torso", x: 30, y: 30, w: 10, h: 10 },
        ],
      },
    ],
  };

  const out = await composeParts(config, dir);
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 60);
  assert.equal(meta.height, 60);
  assert.equal(meta.channels, 4);

  const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number): [number, number, number, number] => {
    const o = (y * 60 + x) * 4;
    return [data[o]!, data[o + 1]!, data[o + 2]!, data[o + 3]!];
  };
  // Head pixel (resized red square at 5..15) is opaque red.
  assert.deepEqual(at(10, 10), [255, 0, 0, 255]);
  // Canvas corner stays transparent.
  assert.equal(at(0, 0)[3], 0);
  // Missing torso slot stays transparent.
  assert.equal(at(35, 35)[3], 0);
});

test("composeParts rejects an invalid config", async () => {
  await assert.rejects(() => composeParts({ meta: {} }, "/tmp"), /invalid layout config/);
});
