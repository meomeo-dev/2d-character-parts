// Frame → atlas composition — port of compose_atlas.py (sharp).
//
// Takes per-state arrays of frame PNGs (already transparent-backed, sized at or
// below 192×208) and lays them onto a single 1536×1872 transparent RGBA canvas,
// one row per state, centring each frame in its cell. Unused / missing cells
// stay fully transparent.
//
// Two invariants matter for downstream playback and validation:
//   1. Every frame is centred in its cell so motion doesn't jump between slots.
//   2. Fully-transparent pixels carry zeroed RGB. sharp/libpng can leave colour
//      residue under alpha==0 (from resizing or compositing); we scrub it before
//      export so validateAtlas's "transparent RGB residue" check stays clean and
//      the atlas is byte-deterministic.
import sharp from "sharp";
import type { OverlayOptions } from "sharp";
import { ATLAS_HEIGHT, ATLAS_WIDTH, CELL_HEIGHT, CELL_WIDTH, ROW_SPECS } from "./contract.ts";

/** Read a PNG as tightly-packed RGBA (4 channels) plus its dimensions. */
async function toRgbaRaw(png: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Compose per-state frame buffers into the fixed Codex pet atlas PNG.
 *
 * `rows` maps a state name to its ordered frame PNGs. For each ROW_SPEC we take
 * the first `usedCols` frames and centre-paste them into that row's cells.
 * Throws if a listed state provides fewer frames than its usedCols (naming which
 * row and how many are missing), so a short row fails loudly rather than
 * composing gaps that would later trip validateAtlas.
 */
export async function composeAtlas(rows: Map<string, Buffer[]>): Promise<Buffer> {
  // Build the overlay list first so a frame shortfall throws before we allocate.
  const composites: OverlayOptions[] = [];

  for (const { state, row, usedCols } of ROW_SPECS) {
    const frames = rows.get(state) ?? [];
    if (frames.length < usedCols) {
      throw new Error(
        `composeAtlas: row "${state}" (row ${row}) needs ${usedCols} frames, got ${frames.length} (missing ${usedCols - frames.length})`,
      );
    }

    for (let col = 0; col < usedCols; col++) {
      const framePng = frames[col]!;
      const frame = await toRgbaRaw(framePng);
      // Reject oversized frames rather than silently cropping them off-cell.
      if (frame.width > CELL_WIDTH || frame.height > CELL_HEIGHT) {
        throw new Error(
          `composeAtlas: row "${state}" frame ${col} is ${frame.width}x${frame.height}; must be <= ${CELL_WIDTH}x${CELL_HEIGHT}`,
        );
      }
      // Centre the (possibly smaller) frame within its cell.
      const left = col * CELL_WIDTH + Math.floor((CELL_WIDTH - frame.width) / 2);
      const top = row * CELL_HEIGHT + Math.floor((CELL_HEIGHT - frame.height) / 2);
      composites.push({
        input: frame.data,
        raw: { width: frame.width, height: frame.height, channels: 4 },
        left,
        top,
      });
    }
  }

  // Composite everything onto a fully-transparent canvas, then read it back raw
  // so we can scrub RGB out from under transparent pixels.
  const composited = await sharp({
    create: {
      width: ATLAS_WIDTH,
      height: ATLAS_HEIGHT,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .raw()
    .toBuffer();

  // Zero the RGB of every fully-transparent pixel (alpha == 0). This mirrors
  // compose_atlas.py's clear_transparent_rgb and guarantees a clean, comparable
  // atlas regardless of what colour libvips left behind the alpha.
  for (let i = 0; i < composited.length; i += 4) {
    if (composited[i + 3] === 0) {
      composited[i] = 0;
      composited[i + 1] = 0;
      composited[i + 2] = 0;
    }
  }

  return sharp(composited, { raw: { width: ATLAS_WIDTH, height: ATLAS_HEIGHT, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * Encode an atlas PNG as lossless WebP. Lossless + full quality + max effort
 * keeps the atlas pixel-exact (matting/compose determinism must survive the
 * format change) while shrinking the file for shipping.
 */
export async function toWebp(png: Buffer): Promise<Buffer> {
  return sharp(png).webp({ lossless: true, quality: 100, effort: 6 }).toBuffer();
}
