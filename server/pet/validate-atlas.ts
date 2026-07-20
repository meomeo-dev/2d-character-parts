// Atlas validation — port of validate_atlas.py (sharp).
//
// Statically verifies a composed Codex pet atlas against the contract: exact
// dimensions, a real alpha channel, per-cell occupancy (used cells non-empty
// but not secretly opaque, unused cells fully transparent), and no colour
// residue hiding under transparent pixels. Everything is computed from one raw
// RGBA read; cells are indexed directly into that buffer rather than re-cropped.
import sharp from "sharp";
import {
  ATLAS_HEIGHT,
  ATLAS_WIDTH,
  CELL_HEIGHT,
  CELL_WIDTH,
  COLUMNS,
  ROW_SPECS,
} from "./contract.ts";

/** Per-cell occupancy stats returned alongside a validation result. */
export interface CellReport {
  state: string;
  row: number;
  column: number;
  used: boolean;
  nontransparentPixels: number;
}

/** Outcome of validateAtlas: ok + collected errors/warnings + optional cells. */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  cells?: CellReport[];
}

/** Tunable thresholds mirroring validate_atlas.py's CLI flags. */
export interface ValidateOptions {
  /** Minimum non-transparent pixels a used cell must carry (default 50). */
  minUsedPixels?: number;
  /** Fraction of a cell that, if opaque, flags a likely solid background (default 0.95). */
  nearOpaqueThreshold?: number;
  /** Skip the alpha-channel requirement (default false). */
  allowOpaque?: boolean;
  /** Demote near-opaque used cells from error to warning (default false). */
  allowNearOpaque?: boolean;
}

/**
 * Validate a composed atlas buffer (PNG or WebP) against the Codex contract.
 *
 * Returns a structured result rather than throwing so callers can surface every
 * problem at once. `ok` is true only when `errors` is empty; warnings never
 * affect `ok`.
 */
export async function validateAtlas(
  atlas: Buffer,
  opts: ValidateOptions = {},
): Promise<ValidationResult> {
  const minUsedPixels = opts.minUsedPixels ?? 50;
  const nearOpaqueThreshold = opts.nearOpaqueThreshold ?? 0.95;
  const allowOpaque = opts.allowOpaque ?? false;
  const allowNearOpaque = opts.allowNearOpaque ?? false;

  const errors: string[] = [];
  const warnings: string[] = [];

  const meta = await sharp(atlas).metadata();
  // ensureAlpha guarantees 4 channels so cell indexing math is uniform even when
  // the source lacked an alpha channel (we report that separately below).
  const { data, info } = await sharp(atlas)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;

  if (width !== ATLAS_WIDTH || height !== ATLAS_HEIGHT) {
    errors.push(`expected ${ATLAS_WIDTH}x${ATLAS_HEIGHT}, got ${width}x${height}`);
  }

  if (!meta.hasAlpha && !allowOpaque) {
    errors.push("atlas does not have an alpha channel");
  }

  // Dimension mismatch makes cell indexing meaningless, so stop after the basic
  // checks and hand back what we have.
  if (width !== ATLAS_WIDTH || height !== ATLAS_HEIGHT) {
    return { ok: errors.length === 0, errors, warnings };
  }

  const cells: CellReport[] = [];
  let totalNontransparent = 0;
  let transparentRgbResidue = 0;
  const nearOpaqueCap = CELL_WIDTH * CELL_HEIGHT * nearOpaqueThreshold;

  // Walk the whole buffer once for the residue tally (any alpha==0 pixel whose
  // RGB is non-zero), then index per-cell for occupancy counts.
  for (let p = 0; p < data.length; p += 4) {
    const alpha = data[p + 3]!;
    if (alpha === 0) {
      if (data[p]! !== 0 || data[p + 1]! !== 0 || data[p + 2]! !== 0) {
        transparentRgbResidue++;
      }
    } else {
      totalNontransparent++;
    }
  }

  for (const { state, row, usedCols } of ROW_SPECS) {
    for (let col = 0; col < COLUMNS; col++) {
      const used = col < usedCols;
      const originX = col * CELL_WIDTH;
      const originY = row * CELL_HEIGHT;

      let nontransparent = 0;
      for (let y = 0; y < CELL_HEIGHT; y++) {
        // Row-major offset of this cell row's first pixel's alpha byte.
        let idx = ((originY + y) * width + originX) * 4 + 3;
        for (let x = 0; x < CELL_WIDTH; x++) {
          if (data[idx]! !== 0) nontransparent++;
          idx += 4;
        }
      }

      cells.push({ state, row, column: col, used, nontransparentPixels: nontransparent });

      if (used && nontransparent < minUsedPixels) {
        errors.push(
          `${state} row ${row} column ${col} is empty or too sparse (${nontransparent} pixels)`,
        );
      }
      if (used && nontransparent > nearOpaqueCap) {
        const message = `${state} row ${row} column ${col} is nearly opaque (${nontransparent} pixels); this usually means the sprite has a non-transparent background`;
        if (allowNearOpaque) warnings.push(message);
        else errors.push(message);
      }
      if (!used && nontransparent !== 0) {
        errors.push(
          `${state} row ${row} unused column ${col} is not transparent (${nontransparent} pixels)`,
        );
      }
    }
  }

  if (totalNontransparent === width * height) {
    const message = "atlas is fully opaque; custom pets require a transparent sprite background";
    if (allowOpaque) warnings.push(message);
    else errors.push(message);
  }

  if (transparentRgbResidue > 0) {
    errors.push(
      `atlas has ${transparentRgbResidue} fully transparent pixels with non-zero RGB residue`,
    );
  }

  return { ok: errors.length === 0, errors, warnings, cells };
}
