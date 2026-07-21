// Contact-sheet overview — port of make_contact_sheet.py (sharp).
//
// Renders a composed Codex pet atlas into a labelled, downscaled overview used
// for human QA: one dark label bar per row, every cell drawn on a light
// checkerboard (so transparent regions read as "empty" rather than white), and a
// coloured frame around each cell (green = a used frame slot, red = an unused
// slot that must stay transparent). Whereas PIL has ImageDraw, sharp only
// composites rasters, so all the "drawing" (checkerboard, label bars, borders,
// text) is produced as SVG overlays and composited in the right z-order:
//   base #f7f7f7  ->  per-row checkerboard  ->  per-row atlas pixels  ->  overlay.
import sharp from "sharp";
import type { OverlayOptions } from "sharp";
import { CELL_HEIGHT, CELL_WIDTH, COLUMNS, ROW_SPECS, ROWS } from "./contract.ts";

/**
 * Height (px) of the dark label bar above each row. Fixed rather than scaled so
 * the caption text stays legible at small scales; the test derives the sheet
 * height from it, so it is exported.
 */
export const LABEL_HEIGHT = 22;

/** Escape the handful of characters that would break an SVG text node. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the checkerboard tile shown behind every cell (full sheet width × one
 * cell height, reused for each row). A <pattern> alternates light squares so
 * transparent sprite pixels are visibly distinct from opaque light-coloured ones.
 */
function checkerSvg(width: number, cellH: number, square: number): string {
  const tile = square * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${cellH}">
  <defs>
    <pattern id="checker" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse">
      <rect width="${tile}" height="${tile}" fill="#ffffff"/>
      <rect width="${square}" height="${square}" fill="#e8e8e8"/>
      <rect x="${square}" y="${square}" width="${square}" height="${square}" fill="#e8e8e8"/>
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill="url(#checker)"/>
</svg>`;
}

/**
 * Build the single top overlay: label bars with captions plus a coloured border
 * and column index for every cell. Drawn last so it sits above the atlas pixels.
 */
function overlaySvg(
  width: number,
  height: number,
  cellW: number,
  cellH: number,
  rowH: number,
): string {
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="sans-serif">`,
  ];
  for (const { state, row, usedCols } of ROW_SPECS) {
    const barTop = row * rowH;
    const cellTop = barTop + LABEL_HEIGHT;
    // Dark caption bar + its label ("row N: state  ·  K frames").
    parts.push(`<rect x="0" y="${barTop}" width="${width}" height="${LABEL_HEIGHT}" fill="#111111"/>`);
    const caption = escapeXml(`row ${row}: ${state}  ·  ${usedCols} frames`);
    parts.push(
      `<text x="6" y="${barTop + LABEL_HEIGHT - 7}" font-size="11" fill="#ffffff">${caption}</text>`,
    );
    for (let col = 0; col < COLUMNS; col++) {
      const x = col * cellW;
      // Green frame for a used slot, red for one that must stay transparent.
      const stroke = col < usedCols ? "#18a058" : "#cc3344";
      // Inset by 0.5px so the 1px stroke lands on the cell edge, not clipped.
      parts.push(
        `<rect x="${x + 0.5}" y="${cellTop + 0.5}" width="${cellW - 1}" height="${cellH - 1}" fill="none" stroke="${stroke}" stroke-width="1"/>`,
      );
      parts.push(
        `<text x="${x + 4}" y="${cellTop + 13}" font-size="10" fill="#111111">${col}</text>`,
      );
    }
  }
  parts.push("</svg>");
  return parts.join("\n");
}

/** Options for {@link makeContactSheet}. */
export interface ContactSheetOptions {
  /** Downscale factor applied to the 1536×1872 atlas (default 0.5). */
  scale?: number;
}

/**
 * Render a labelled contact sheet from a composed atlas buffer (PNG or WebP).
 *
 * Returns a PNG buffer sized `COLUMNS*cellW` wide by `ROWS*(cellH+LABEL_HEIGHT)`
 * tall, where cellW/cellH are the atlas cell dimensions scaled by `scale`.
 */
export async function makeContactSheet(
  atlas: Buffer,
  opts: ContactSheetOptions = {},
): Promise<Buffer> {
  const scale = opts.scale ?? 0.5;
  const cellW = Math.max(1, Math.round(CELL_WIDTH * scale));
  const cellH = Math.max(1, Math.round(CELL_HEIGHT * scale));
  const width = COLUMNS * cellW;
  const rowH = cellH + LABEL_HEIGHT;
  const height = ROWS * rowH;
  const square = Math.max(4, Math.round(16 * scale));

  // Downscale the whole atlas once; row bands are then extracted from it so a
  // single resize governs every cell (matches the Python per-cell LANCZOS crop
  // closely while doing far fewer sharp passes).
  const scaled = await sharp(atlas)
    .ensureAlpha()
    .resize(width, ROWS * cellH, { fit: "fill" })
    .png()
    .toBuffer();

  const checkerBand = await sharp(Buffer.from(checkerSvg(width, cellH, square)))
    .png()
    .toBuffer();

  const composites: OverlayOptions[] = [];
  for (let row = 0; row < ROWS; row++) {
    const cellTop = row * rowH + LABEL_HEIGHT;
    // Checkerboard first, then the atlas row band composited over it so
    // transparent sprite pixels reveal the checker beneath.
    composites.push({ input: checkerBand, left: 0, top: cellTop });
    const band = await sharp(scaled)
      .extract({ left: 0, top: row * cellH, width, height: cellH })
      .png()
      .toBuffer();
    composites.push({ input: band, left: 0, top: cellTop });
  }
  // Labels/borders/indices drawn last, on top of everything.
  composites.push({ input: Buffer.from(overlaySvg(width, height, cellW, cellH, rowH)), left: 0, top: 0 });

  return sharp({
    create: { width, height, channels: 4, background: { r: 247, g: 247, b: 247, alpha: 1 } },
  })
    .composite(composites)
    .png()
    .toBuffer();
}
