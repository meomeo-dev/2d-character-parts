// Single-row frame inspection — port of inspect_frames.py (sharp).
//
// Quality-checks the extracted frames for one animation state *before* they are
// composed into the atlas, catching problems (wrong count, wrong size, empty
// frames, subjects bleeding into cell edges, sudden size popping) while they can
// still be traced back to a single row. Errors block composition; warnings are
// for human visual review. The chroma-key checks from the Python original are
// omitted here because this deterministic layer works on already-matted,
// transparent frames (no chroma key in play).
import sharp from "sharp";
import { CELL_HEIGHT, CELL_WIDTH, usedColsFor } from "./contract.ts";

/** Per-frame stats collected during inspection. */
export interface FrameReport {
  index: number;
  width: number;
  height: number;
  nontransparentPixels: number;
  edgePixels: number;
}

/** Outcome of inspectFrames for one state's row. */
export interface FrameInspection {
  state: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  frames: FrameReport[];
}

/** Tunable thresholds mirroring inspect_frames.py's CLI flags. */
export interface InspectOptions {
  /** Minimum non-transparent pixels a frame must carry (default 400). */
  minUsedPixels?: number;
  /** Edge-band width scanned for bleed, in pixels (default 2). */
  edgeMargin?: number;
  /** Non-transparent pixels allowed in the edge band before warning (default 24). */
  edgeThreshold?: number;
  /** A frame smaller than median × this ratio warns as size popping (default 0.35). */
  smallOutlierRatio?: number;
  /** A frame larger than median × this ratio warns as size popping (default 2.75). */
  largeOutlierRatio?: number;
}

/** Median of a numeric list; averages the two middle values for even counts. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Read a frame as raw RGBA and count total non-transparent pixels plus those
 * inside the `margin`-wide border band. The band is the union of the four edge
 * strips (corners counted once), so `edgePixels` is a true unique count.
 */
async function frameStats(
  png: Buffer,
  margin: number,
): Promise<{ width: number; height: number; nontransparent: number; edge: number }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  let nontransparent = 0;
  let edge = 0;
  for (let y = 0; y < height; y++) {
    const inVerticalBand = y < margin || y >= height - margin;
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3]!;
      if (alpha === 0) continue;
      nontransparent++;
      if (inVerticalBand || x < margin || x >= width - margin) edge++;
    }
  }
  return { width, height, nontransparent, edge };
}

/**
 * Inspect one state's frame buffers. Frame count is checked against the
 * contract's usedCols for `state` (throws if the state is unknown). Size and
 * emptiness are hard errors; edge bleed and size popping are warnings for visual
 * review.
 */
export async function inspectFrames(
  frames: Buffer[],
  state: string,
  opts: InspectOptions = {},
): Promise<FrameInspection> {
  const minUsedPixels = opts.minUsedPixels ?? 400;
  const edgeMargin = opts.edgeMargin ?? 2;
  const edgeThreshold = opts.edgeThreshold ?? 24;
  const smallOutlierRatio = opts.smallOutlierRatio ?? 0.35;
  const largeOutlierRatio = opts.largeOutlierRatio ?? 2.75;

  const expected = usedColsFor(state);
  const errors: string[] = [];
  const warnings: string[] = [];
  const reports: FrameReport[] = [];
  const areas: number[] = [];

  if (frames.length !== expected) {
    errors.push(`expected ${expected} frame files for ${state}, found ${frames.length}`);
  }

  for (let index = 0; index < frames.length; index++) {
    const stats = await frameStats(frames[index]!, edgeMargin);
    reports.push({
      index,
      width: stats.width,
      height: stats.height,
      nontransparentPixels: stats.nontransparent,
      edgePixels: stats.edge,
    });
    areas.push(stats.nontransparent);

    if (stats.width !== CELL_WIDTH || stats.height !== CELL_HEIGHT) {
      errors.push(
        `${state} frame ${String(index).padStart(2, "0")} is ${stats.width}x${stats.height}; expected ${CELL_WIDTH}x${CELL_HEIGHT}`,
      );
    }
    if (stats.nontransparent < minUsedPixels) {
      errors.push(
        `${state} frame ${String(index).padStart(2, "0")} is empty or too sparse (${stats.nontransparent} pixels)`,
      );
    }
    if (stats.edge > edgeThreshold) {
      warnings.push(
        `${state} frame ${String(index).padStart(2, "0")} has ${stats.edge} non-transparent pixels near the cell edge; the character may be clipped or bleeding into an adjacent cell`,
      );
    }
  }

  // Size-popping check: compare each frame's occupied-pixel count against the
  // row median so a single frame that suddenly balloons or shrinks is flagged.
  const rowMedian = median(areas);
  if (rowMedian > 0) {
    for (let index = 0; index < areas.length; index++) {
      const area = areas[index]!;
      if (area < rowMedian * smallOutlierRatio) {
        warnings.push(
          `${state} frame ${String(index).padStart(2, "0")} is much smaller than the row median (${area} vs ${rowMedian.toFixed(0)}); possible size popping`,
        );
      } else if (area > rowMedian * largeOutlierRatio) {
        warnings.push(
          `${state} frame ${String(index).padStart(2, "0")} is much larger than the row median (${area} vs ${rowMedian.toFixed(0)}); possible size popping`,
        );
      }
    }
  }

  return { state, ok: errors.length === 0, errors, warnings, frames: reports };
}
