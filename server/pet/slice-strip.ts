// Horizontal strip → per-cell frame slicer (sharp).
//
// gpt-image renders each animation state as ONE horizontal strip: a single
// transparent-background image holding N poses laid out left-to-right in N
// equal-width invisible "slots" (see buildRowPrompt, which instructs exactly
// this layout). This module cuts that strip back into N individual 192×208
// transparent frames that composeAtlas can drop straight into an atlas row.
//
// Why equal-width slicing + trim + centre (and not connected-component slot
// extraction like hatch-pet's Python scripts):
//   - The prompt pins the pet to N evenly-spaced equal-width slots, so a plain
//     `floor(width / frameCount)` cut lands one pose per segment. This is the
//     same "component/slot" idea as hatch-pet, but geometric rather than blob-
//     based, which keeps it deterministic and dependency-free.
//   - hatch-pet worked on a chroma-keyed (solid-colour) background and needed
//     connected-component analysis to find each sprite. Our strips are already
//     transparent-backed, so we can lean on the alpha channel directly: sharp's
//     `.trim()` crops the fully-transparent border off each segment, recovering
//     a tight bounding box around the pose without any blob math.
//   - After trimming we scale the pose to *fit* inside a 192×208 cell (never
//     upscaling past it, preserving aspect) and centre it on a fresh
//     transparent canvas. Centring matches composeAtlas's own per-cell centring
//     so motion doesn't jump between slots, and the fixed 192×208 output is what
//     inspectFrames / composeAtlas require.
import sharp from "sharp";
import { CELL_HEIGHT, CELL_WIDTH } from "./contract.ts";

/**
 * Slice a horizontal strip into `frameCount` transparent 192×208 frames.
 *
 * Each output frame is the corresponding strip segment, trimmed of its
 * transparent border, scaled to fit (without upscaling beyond the cell) and
 * centred on a 192×208 transparent RGBA canvas. Throws if `frameCount` is not a
 * positive integer or the strip is too narrow to yield one column per frame.
 */
export async function sliceStrip(strip: Buffer, frameCount: number): Promise<Buffer[]> {
  if (!Number.isInteger(frameCount) || frameCount <= 0) {
    throw new Error(`sliceStrip: frameCount must be a positive integer, got ${frameCount}`);
  }

  // Read the source dimensions up front so we can compute equal-width columns.
  const meta = await sharp(strip).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error(`sliceStrip: could not read strip dimensions (${width}x${height})`);
  }

  // Equal-width slots: floor so we never index past the right edge. A remainder
  // (width not divisible by frameCount) just leaves a few unused pixels at the
  // far right, which is harmless since the pose sits mid-slot.
  const cellW = Math.floor(width / frameCount);
  if (cellW <= 0) {
    throw new Error(`sliceStrip: strip width ${width} is too small for ${frameCount} frames`);
  }

  const frames: Buffer[] = [];
  for (let i = 0; i < frameCount; i++) {
    const left = i * cellW;
    // Clamp the last segment's width so left+segW never exceeds the image (guards
    // against rounding when width isn't an exact multiple of frameCount).
    const segW = Math.min(cellW, width - left);

    // 1. Extract this slot as its own transparent PNG.
    const segment = await sharp(strip)
      .extract({ left, top: 0, width: segW, height })
      .png()
      .toBuffer();

    // 2. Trim the transparent border to a tight bounding box around the pose.
    //    trim can throw (e.g. a fully-transparent segment has nothing to trim);
    //    fall back to the untrimmed segment so an empty slot still yields a
    //    valid 192×208 frame for inspectFrames to flag downstream.
    let trimmed: Buffer;
    try {
      trimmed = await sharp(segment).trim().png().toBuffer();
    } catch {
      trimmed = segment;
    }

    // 3. Scale to fit inside the cell (never enlarge past it), preserving aspect,
    //    then centre on a fresh fully-transparent 192×208 canvas. `fit: "inside"`
    //    + `withoutEnlargement` keeps the pose from bleeding over cell edges;
    //    `extend`/`extract`-free centring comes from a flat composite below.
    const fitted = await sharp(trimmed)
      .resize(CELL_WIDTH, CELL_HEIGHT, {
        fit: "inside",
        withoutEnlargement: true,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .ensureAlpha()
      .png()
      .toBuffer();

    // Re-measure the fitted pose so we can centre it exactly; a resize with
    // fit:"inside" yields dimensions <= the cell but not necessarily equal to it.
    const fittedMeta = await sharp(fitted).metadata();
    const fw = fittedMeta.width ?? CELL_WIDTH;
    const fh = fittedMeta.height ?? CELL_HEIGHT;
    const offLeft = Math.floor((CELL_WIDTH - fw) / 2);
    const offTop = Math.floor((CELL_HEIGHT - fh) / 2);

    const frame = await sharp({
      create: {
        width: CELL_WIDTH,
        height: CELL_HEIGHT,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: fitted, left: offLeft, top: offTop }])
      .png()
      .toBuffer();

    frames.push(frame);
  }

  return frames;
}
