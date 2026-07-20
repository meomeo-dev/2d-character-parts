// Horizontal frame mirroring (sharp).
//
// Several pet states are exact left/right reflections of each other — most
// obviously running-right ↔ running-left. Rather than pay for a second image
// generation (and risk the model drifting the pet's identity between the two
// directions), we derive the mirrored row by flipping the already-approved
// frames of its counterpart.
//
// Why flop and why order is preserved:
//   - sharp's `.flop()` mirrors along the vertical axis (left↔right), which is
//     exactly the transform between "moving right" and "moving left". `.flip()`
//     (top↔bottom) would be wrong.
//   - We map frame i → frame i without reordering. A drag-right loop and its
//     mirror play through the same phases at the same time; reversing the frames
//     would desync the two animations. So mirroring is purely per-frame pixel
//     work with a stable index.
import sharp from "sharp";

/**
 * Return horizontally-mirrored copies of `frames`, one per input, in the same
 * order. Each output stays a transparent PNG at the input's dimensions (flop
 * doesn't change size), so the result is drop-in for the same 192×208 cells.
 */
export async function mirrorFrames(frames: Buffer[]): Promise<Buffer[]> {
  const mirrored: Buffer[] = [];
  for (let i = 0; i < frames.length; i++) {
    // Non-null assertion: i is bounded by frames.length, so the index is present
    // (noUncheckedIndexedAccess otherwise widens this to Buffer | undefined).
    const frame = frames[i]!;
    const flopped = await sharp(frame).flop().png().toBuffer();
    mirrored.push(flopped);
  }
  return mirrored;
}
