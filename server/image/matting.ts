// Triangulation matting — port of matting.py (sharp).
//
// Recovers a straight-alpha transparent PNG from the same subject rendered on a
// white and a black background.
//
// Algorithm (per matting.py):
//   C_white = α·C_fg + (1-α)·1     C_black = α·C_fg + (1-α)·0
//   ⇒ C_white - C_black = 1 - α    ⇒ α = 1 - (C_white - C_black)
//   C_fg = C_black / α  (safe division)
// α is taken per-channel, clamped to [0,1], then max across RGB for robustness.
import sharp from "sharp";

/** Read an image as tightly-packed RGB (3 channels), returning pixels + size. */
async function toRgbRaw(png: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Recover a transparent PNG from white-bg and black-bg renders of a subject. */
export async function triangulationMatting(whitePng: Buffer, blackPng: Buffer): Promise<Buffer> {
  const white = await toRgbRaw(whitePng);

  // Resize the black render to match the white render if dimensions differ.
  let blackBuf = blackPng;
  const blackMeta = await sharp(blackPng).metadata();
  if (blackMeta.width !== white.width || blackMeta.height !== white.height) {
    blackBuf = await sharp(blackPng)
      .resize(white.width, white.height, { fit: "fill", kernel: "lanczos3" })
      .png()
      .toBuffer();
  }
  const black = await toRgbRaw(blackBuf);

  const { width, height } = white;
  const w = white.data;
  const b = black.data;
  const out = Buffer.alloc(width * height * 4);

  const px = width * height;
  for (let i = 0; i < px; i++) {
    const s = i * 3;
    const wr = w[s]! / 255;
    const wg = w[s + 1]! / 255;
    const wb = w[s + 2]! / 255;
    const br = b[s]! / 255;
    const bg = b[s + 1]! / 255;
    const bb = b[s + 2]! / 255;

    // α = 1 - (C_white - C_black) per channel, clamped, then max across RGB.
    const ar = Math.min(1, Math.max(0, 1 - (wr - br)));
    const ag = Math.min(1, Math.max(0, 1 - (wg - bg)));
    const ab = Math.min(1, Math.max(0, 1 - (wb - bb)));
    const alpha = Math.max(ar, ag, ab);

    const o = i * 4;
    if (alpha < 0.01) {
      // Zero out fully-transparent pixels to avoid fringe noise.
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 0;
      continue;
    }

    const safe = alpha > 0.005 ? alpha : 1.0;
    const inv = 1 / safe;
    out[o] = Math.min(255, Math.max(0, Math.round(br * inv * 255)));
    out[o + 1] = Math.min(255, Math.max(0, Math.round(bg * inv * 255)));
    out[o + 2] = Math.min(255, Math.max(0, Math.round(bb * inv * 255)));
    out[o + 3] = Math.min(255, Math.max(0, Math.round(alpha * 255)));
  }

  return sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
