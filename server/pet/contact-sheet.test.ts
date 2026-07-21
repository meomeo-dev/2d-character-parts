// Tests for makeContactSheet: a compliant transparent atlas in, a correctly
// sized decodable PNG out. Run:
//   node --import tsx --test --experimental-test-module-mocks server/pet/contact-sheet.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { ATLAS_HEIGHT, ATLAS_WIDTH, CELL_HEIGHT, CELL_WIDTH, COLUMNS, ROWS } from "./contract.ts";
import { LABEL_HEIGHT, makeContactSheet } from "./contact-sheet.ts";

/** A fully transparent, contract-sized RGBA atlas PNG. */
async function blankAtlas(): Promise<Buffer> {
  return sharp({
    create: {
      width: ATLAS_WIDTH,
      height: ATLAS_HEIGHT,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
}

/**
 * A contract-sized atlas carrying one opaque colour block centred in cell (0,0),
 * so the sheet exercises real sprite pixels over the checkerboard, not just
 * transparency.
 */
async function atlasWithBlock(): Promise<Buffer> {
  const block = await sharp({
    create: { width: 90, height: 120, channels: 4, background: { r: 40, g: 120, b: 220, alpha: 255 } },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: ATLAS_WIDTH, height: ATLAS_HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: block, left: 50, top: 40 }])
    .png()
    .toBuffer();
}

test("makeContactSheet returns a PNG of the expected size (default scale 0.5)", async () => {
  const sheet = await makeContactSheet(await blankAtlas());
  const meta = await sharp(sheet).metadata();

  const cellW = Math.round(CELL_WIDTH * 0.5);
  const cellH = Math.round(CELL_HEIGHT * 0.5);
  assert.equal(meta.format, "png");
  assert.equal(meta.width, COLUMNS * cellW);
  assert.equal(meta.height, ROWS * (cellH + LABEL_HEIGHT));
});

test("makeContactSheet honours a custom scale", async () => {
  const scale = 0.25;
  const sheet = await makeContactSheet(await atlasWithBlock(), { scale });
  const meta = await sharp(sheet).metadata();

  const cellW = Math.round(CELL_WIDTH * scale);
  const cellH = Math.round(CELL_HEIGHT * scale);
  assert.equal(meta.width, COLUMNS * cellW);
  assert.equal(meta.height, ROWS * (cellH + LABEL_HEIGHT));

  // Decodes cleanly to raw pixels (no corrupt output).
  const { info } = await sharp(sheet).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, COLUMNS * cellW);
});
