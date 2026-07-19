// Sprite-sheet animation helpers — port of sprite_animation.py (sharp + gifenc).
//
// STUB: implemented by a later track. createGrid renders the blank img2img
// reference grid; sliceAndGif cuts a finished sheet into frames and encodes a
// preview GIF; buildPrompt assembles the img2img prompt.

/** A rendered grid template plus its measured pixel dimensions. */
export interface GridResult {
  png: Buffer;
  w: number;
  h: number;
}

/** Render a blank rows×cols reference grid at the given target width. */
export async function createGrid(
  rows: number,
  cols: number,
  width: number,
  line?: number,
): Promise<GridResult> {
  void rows;
  void cols;
  void width;
  void line;
  throw new Error("not implemented: animation track (create_grid_image port)");
}

/** Options for slicing a sheet into a preview GIF. */
export interface SliceAndGifOptions {
  fps?: number;
  loop?: number;
  outPath?: string;
}

/** Slice a finished sprite sheet into frames and encode a preview GIF. */
export async function sliceAndGif(
  sheet: Buffer,
  rows: number,
  cols: number,
  opts?: SliceAndGifOptions,
): Promise<Buffer> {
  void sheet;
  void rows;
  void cols;
  void opts;
  throw new Error("not implemented: animation track (slice_and_gif port)");
}

/** Options for the img2img sprite-sheet prompt. */
export interface BuildPromptOptions {
  style?: string;
  era?: string;
  lighting?: string;
  composition?: string;
  color?: string;
  mode?: string;
  prevPromptContext?: string;
}

/** Build the img2img prompt for a rows×cols sprite sheet from a description. */
export function buildPrompt(
  description: string,
  rows: number,
  cols: number,
  opts?: BuildPromptOptions,
): string {
  void description;
  void rows;
  void cols;
  void opts;
  throw new Error("not implemented: animation track (build_prompt port)");
}
