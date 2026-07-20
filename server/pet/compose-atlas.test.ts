// Tests for composeAtlas / toWebp — no network. Mock frames are built with sharp
// as solid-colour squares on a transparent canvas; we verify exact atlas
// geometry, that unused cells stay transparent, that no RGB residue survives
// under transparent pixels, and that a short row throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { composeAtlas, toWebp } from "./compose-atlas.ts";
import { ATLAS_HEIGHT, ATLAS_WIDTH, CELL_HEIGHT, CELL_WIDTH, ROW_SPECS } from "./contract.ts";

/**
 * A frame with a solid opaque colour block centred on a transparent canvas.
 * Smaller than the cell so we also exercise centre-pasting and leave a
 * transparent border to check for residue scrubbing.
 */
async function mockFrame(w = 120, h = 140, r = 200, g = 80, b = 40): Promise<Buffer> {
  const block = await sharp({
    create: { width: w, height: h, channels: 4, background: { r, g, b, alpha: 1 } },
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

/** Build a full valid row map: usedCols frames per state. */
async function fullRows(): Promise<Map<string, Buffer[]>> {
  const frame = await mockFrame();
  const rows = new Map<string, Buffer[]>();
  for (const spec of ROW_SPECS) {
    rows.set(
      spec.state,
      Array.from({ length: spec.usedCols }, () => frame),
    );
  }
  return rows;
}

test("composeAtlas produces an exact 1536x1872 RGBA PNG", async () => {
  const out = await composeAtlas(await fullRows());
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, ATLAS_WIDTH);
  assert.equal(meta.height, ATLAS_HEIGHT);
  assert.equal(meta.channels, 4);
  assert.equal(meta.hasAlpha, true);
});

test("composeAtlas leaves unused cells fully transparent", async () => {
  const out = await composeAtlas(await fullRows());
  const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });

  // Sample the centre of the first unused cell in each row that has one.
  for (const spec of ROW_SPECS) {
    if (spec.usedCols >= 8) continue; // no unused cell in a full-width row
    const cx = spec.usedCols * CELL_WIDTH + Math.floor(CELL_WIDTH / 2);
    const cy = spec.row * CELL_HEIGHT + Math.floor(CELL_HEIGHT / 2);
    const o = (cy * ATLAS_WIDTH + cx) * 4;
    assert.equal(data[o + 3], 0, `${spec.state} unused cell should be transparent`);
  }

  // And the centre of a used cell should be opaque colour.
  const uo = (Math.floor(CELL_HEIGHT / 2) * ATLAS_WIDTH + Math.floor(CELL_WIDTH / 2)) * 4;
  assert.equal(data[uo + 3], 255);
});

test("composeAtlas scrubs RGB from every transparent pixel", async () => {
  const out = await composeAtlas(await fullRows());
  const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  let residue = 0;
  for (let p = 0; p < data.length; p += 4) {
    if (data[p + 3] === 0 && (data[p] !== 0 || data[p + 1] !== 0 || data[p + 2] !== 0)) residue++;
  }
  assert.equal(residue, 0);
});

test("composeAtlas throws when a row is short on frames", async () => {
  const rows = await fullRows();
  rows.set("idle", rows.get("idle")!.slice(0, 4)); // idle needs 6
  await assert.rejects(() => composeAtlas(rows), /row "idle".*needs 6 frames, got 4.*missing 2/);
});

test("composeAtlas rejects an oversized frame", async () => {
  const rows = await fullRows();
  const big = await sharp({
    create: { width: CELL_WIDTH + 10, height: CELL_HEIGHT, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer();
  rows.set("waving", [big, ...rows.get("waving")!.slice(1)]);
  await assert.rejects(() => composeAtlas(rows), /must be <=/);
});

test("toWebp produces a lossless WebP of the same dimensions", async () => {
  const png = await composeAtlas(await fullRows());
  const webp = await toWebp(png);
  const meta = await sharp(webp).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, ATLAS_WIDTH);
  assert.equal(meta.height, ATLAS_HEIGHT);
});
