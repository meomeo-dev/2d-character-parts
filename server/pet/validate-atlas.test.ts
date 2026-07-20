// Tests for validateAtlas — no network. We build a compliant atlas via
// composeAtlas, then construct broken variants by editing raw RGBA and re-encoding.
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { composeAtlas } from "./compose-atlas.ts";
import { validateAtlas } from "./validate-atlas.ts";
import { ATLAS_HEIGHT, ATLAS_WIDTH, CELL_HEIGHT, CELL_WIDTH, ROW_SPECS } from "./contract.ts";

async function mockFrame(): Promise<Buffer> {
  const block = await sharp({
    create: { width: 120, height: 140, channels: 4, background: { r: 200, g: 80, b: 40, alpha: 1 } },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: CELL_WIDTH, height: CELL_HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: block, left: Math.floor((CELL_WIDTH - 120) / 2), top: Math.floor((CELL_HEIGHT - 140) / 2) }])
    .png()
    .toBuffer();
}

async function compliantAtlas(): Promise<Buffer> {
  const frame = await mockFrame();
  const rows = new Map<string, Buffer[]>();
  for (const spec of ROW_SPECS) {
    rows.set(spec.state, Array.from({ length: spec.usedCols }, () => frame));
  }
  return composeAtlas(rows);
}

/** Read atlas → raw RGBA so a test can poke pixels and re-encode. */
async function rawOf(atlas: Buffer): Promise<Buffer> {
  return sharp(atlas).ensureAlpha().raw().toBuffer();
}
function rawToPng(raw: Buffer): Promise<Buffer> {
  return sharp(raw, { raw: { width: ATLAS_WIDTH, height: ATLAS_HEIGHT, channels: 4 } }).png().toBuffer();
}

test("(a) a compliant atlas validates ok with no errors or warnings", async () => {
  const result = await validateAtlas(await compliantAtlas());
  assert.equal(result.ok, true, `unexpected errors: ${result.errors.join("; ")}`);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.cells?.length, ROW_SPECS.length * 8);
});

test("(b) a wrong-size image is an error", async () => {
  const wrong = await sharp({
    create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
  const result = await validateAtlas(wrong);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /expected 1536x1872, got 100x100/.test(e)));
});

test("(c) a non-transparent pixel in an unused cell is an error", async () => {
  const raw = await rawOf(await compliantAtlas());
  // "waving" (row 3) uses 4 cols; poke a pixel in the centre of unused col 6.
  const spec = ROW_SPECS.find((s) => s.state === "waving")!;
  const x = 6 * CELL_WIDTH + CELL_WIDTH / 2;
  const y = spec.row * CELL_HEIGHT + CELL_HEIGHT / 2;
  const o = (y * ATLAS_WIDTH + x) * 4;
  raw[o] = 255;
  raw[o + 1] = 255;
  raw[o + 2] = 255;
  raw[o + 3] = 255;
  const result = await validateAtlas(await rawToPng(raw));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /waving row 3 unused column 6 is not transparent/.test(e)));
});

test("(d) transparent pixels with RGB residue are an error", async () => {
  const raw = await rawOf(await compliantAtlas());
  // Corner pixel (0,0) is transparent in a used-but-centred frame's border.
  raw[0] = 123; // R
  raw[1] = 45; // G
  raw[2] = 67; // B
  raw[3] = 0; // stays transparent
  const result = await validateAtlas(await rawToPng(raw));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /transparent pixels with non-zero RGB residue/.test(e)));
});

test("a used cell that is empty is flagged as too sparse", async () => {
  const frame = await mockFrame();
  const empty = await sharp({
    create: { width: CELL_WIDTH, height: CELL_HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
  const rows = new Map<string, Buffer[]>();
  for (const spec of ROW_SPECS) {
    rows.set(spec.state, Array.from({ length: spec.usedCols }, () => frame));
  }
  // Make idle's first frame empty (transparent), which composeAtlas allows but
  // validateAtlas must reject as too sparse.
  rows.set("idle", [empty, ...rows.get("idle")!.slice(1)]);
  const result = await validateAtlas(await composeAtlas(rows));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /idle row 0 column 0 is empty or too sparse/.test(e)));
});
