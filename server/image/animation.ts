// Sprite-sheet animation helpers — port of sprite_animation.py (sharp + gifenc).
//
// createGrid renders the blank img2img reference grid; sliceAndGif cuts a
// finished sheet into frames and encodes a preview GIF; buildPrompt assembles
// the img2img prompt. AnimationStore persists time-ordered records.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import gifenc from "gifenc";

const { GIFEncoder, quantize, applyPalette } = gifenc;

// Min / max grid dimension, inclusive (matches the reference template rules).
const MIN_DIM = 2;
const MAX_DIM = 6;

/** Clamp `lineWidth` to the smallest even width (>= 2). */
function normalizeLineWidth(lineWidth: number): number {
  if (lineWidth < 2 || lineWidth % 2 !== 0) return 2;
  return lineWidth;
}

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
  line = 2,
): Promise<GridResult> {
  if (!(MIN_DIM <= rows && rows <= MAX_DIM && MIN_DIM <= cols && cols <= MAX_DIM)) {
    throw new Error("Rows and columns must be between 2 and 6.");
  }
  const lineWidth = normalizeLineWidth(line);

  // width = (cols + 1) * lineWidth + cols * cellSize  ->  solve for cellSize.
  const available = width - (cols + 1) * lineWidth;
  if (available <= 0) {
    throw new Error("Target width is too small for the given columns and line width.");
  }
  const cellSize = Math.floor(available / cols);

  // Recompute the real canvas so every cell is an exact square.
  const actualWidth = cols * cellSize + (cols + 1) * lineWidth;
  const actualHeight = rows * cellSize + (rows + 1) * lineWidth;

  // White RGB canvas, then paint black line rectangles (exact even width).
  const buf = Buffer.alloc(actualWidth * actualHeight * 3, 255);

  const paintRect = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = y0; y <= y1; y++) {
      const rowOff = y * actualWidth * 3;
      for (let x = x0; x <= x1; x++) {
        const o = rowOff + x * 3;
        buf[o] = 0;
        buf[o + 1] = 0;
        buf[o + 2] = 0;
      }
    }
  };

  // Vertical lines.
  for (let i = 0; i <= cols; i++) {
    const x = i * (cellSize + lineWidth);
    paintRect(x, 0, x + lineWidth - 1, actualHeight - 1);
  }
  // Horizontal lines.
  for (let j = 0; j <= rows; j++) {
    const y = j * (cellSize + lineWidth);
    paintRect(0, y, actualWidth - 1, y + lineWidth - 1);
  }

  const png = await sharp(buf, { raw: { width: actualWidth, height: actualHeight, channels: 3 } })
    .png()
    .toBuffer();
  return { png, w: actualWidth, h: actualHeight };
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

/** Return a usable modifier, or undefined for empty / sentinel ("None") values. */
function cleanModifier(value: string | undefined): string | undefined {
  if (!value || value === "None") return undefined;
  return value;
}

/** Build the img2img prompt for a rows×cols sprite sheet from a description. */
export function buildPrompt(
  description: string,
  rows: number,
  cols: number,
  opts: BuildPromptOptions = {},
): string {
  const segments: string[] = [];
  const style = cleanModifier(opts.style);
  if (style) segments.push(`${style} style`);
  const era = cleanModifier(opts.era);
  if (era) segments.push(`${era} era`);
  const lighting = cleanModifier(opts.lighting);
  if (lighting) segments.push(`${lighting}`);
  const composition = cleanModifier(opts.composition);
  if (composition) segments.push(`${composition}`);
  const color = cleanModifier(opts.color);
  if (color) segments.push(`${color} colors`);

  const joined = segments.join(", ");
  const modifiers = joined ? `, ${joined}` : "";

  const basePrompt =
    `Sprite sheet of a ${description} illustration${modifiers}, ` +
    `${rows}x${cols} grid (${rows} rows and ${cols} columns), ` +
    "white background, sequence, frame by frame animation, square aspect ratio.";

  const mode = opts.mode ?? "new";
  if (mode === "continue" && opts.prevPromptContext) {
    return (
      "Create a new image by continuing the animation sequence:\n\n" +
      `${basePrompt}\n\n` +
      "**CONTINUATION CONTEXT**:\n" +
      "This is a continuation of a previous animation sequence.\n" +
      `Previous Prompt Context: "${opts.prevPromptContext}"\n` +
      `Current Prompt Context: "${description}"\n\n` +
      "The first row of the attached image contains the LAST frames of the previous sequence.\n" +
      "Please generate the subsequent frames in the remaining rows to continue the action " +
      "defined by the Current Prompt Context.\n" +
      "Follow the structure of the attached reference image exactly.\n" +
      "Do not change the input aspect ratio.\n\n" +
      "Return the drawn picture."
    );
  }

  return (
    "Create a new image by :\n\n" +
    `${basePrompt} Follow the structure of the attached reference image exactly.\n\n` +
    "Do not change the input aspect ratio.\n\n" +
    "Return the drawn picture."
  );
}

/** Options for slicing a sheet into a preview GIF. */
export interface SliceAndGifOptions {
  /** Frame duration in milliseconds (default 200). Overrides `fps` when set. */
  duration?: number;
  /** Alternative to `duration`: frames per second. */
  fps?: number;
  /** Loop count: 0 = infinite (default), -1 = play once, n = repeat n times. */
  loop?: number;
  /** Grid line width used when the sheet was generated (default 2). */
  lineWidth?: number;
  /** When set, also write the encoded GIF to this path. */
  outPath?: string;
}

/**
 * Slice a finished sprite sheet into `rows*cols` frames (row-major) and encode
 * an animated GIF. Cell sizes are reverse-computed from the sheet's actual
 * dimensions so a differently-scaled sheet still slices cleanly.
 */
export async function sliceAndGif(
  sheet: Buffer,
  rows: number,
  cols: number,
  opts: SliceAndGifOptions = {},
): Promise<Buffer> {
  const lineWidth = normalizeLineWidth(opts.lineWidth ?? 2);
  const duration =
    opts.duration ?? (opts.fps && opts.fps > 0 ? Math.round(1000 / opts.fps) : 200);
  const loop = opts.loop ?? 0;

  const meta = await sharp(sheet).metadata();
  const totalWidth = meta.width;
  const totalHeight = meta.height;

  const availableW = totalWidth - (cols + 1) * lineWidth;
  const availableH = totalHeight - (rows + 1) * lineWidth;
  if (availableW <= 0 || availableH <= 0) {
    throw new Error("Sheet image is too small for the given grid.");
  }
  const cellW = Math.floor(availableW / cols);
  const cellH = Math.floor(availableH / rows);

  const gif = GIFEncoder();

  // Row-major frame order.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const left = c * (cellW + lineWidth) + lineWidth;
      const top = r * (cellH + lineWidth) + lineWidth;
      const { data } = await sharp(sheet)
        .extract({ left, top, width: cellW, height: cellH })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const palette = quantize(rgba, 256, { format: "rgb444" });
      const index = applyPalette(rgba, palette, "rgb444");
      gif.writeFrame(index, cellW, cellH, { palette, delay: duration, repeat: loop });
    }
  }

  gif.finish();
  const bytes = gif.bytes();
  const out = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (opts.outPath) {
    mkdirSync(dirname(opts.outPath), { recursive: true });
    writeFileSync(opts.outPath, out);
  }
  return out;
}

/** A persisted animation record. Extra fields are preserved verbatim. */
export interface AnimationRecord {
  id?: string;
  timestamp?: string;
  status?: string;
  image_path?: string;
  gif_path?: string;
  prompt?: string;
  description?: string;
  grid_config?: { rows: number; cols: number };
  style?: string;
  idea?: string;
  generation_mode?: string;
  [key: string]: unknown;
}

/** Recursively merge `patch` into `base` in place and return `base`. */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(patch)) {
    const cur = base[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      cur &&
      typeof cur === "object" &&
      !Array.isArray(cur)
    ) {
      deepMerge(cur as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      base[key] = value;
    }
  }
  return base;
}

/** Lightweight project manager persisting time-ordered records to history.json. */
export class AnimationStore {
  readonly root: string;
  readonly historyPath: string;
  private records: AnimationRecord[];

  /** Create a store rooted at `root` (holds history.json); load existing records. */
  constructor(root: string) {
    this.root = root;
    this.historyPath = join(root, "history.json");
    this.records = this.load();
  }

  private load(): AnimationRecord[] {
    if (!existsSync(this.historyPath)) return [];
    try {
      const data = JSON.parse(readFileSync(this.historyPath, "utf-8"));
      return Array.isArray(data) ? (data as AnimationRecord[]) : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.historyPath, JSON.stringify(this.records, null, 2) + "\n", "utf-8");
  }

  /** Append `record` (assigning id + timestamp if absent); return its id. */
  add(record: AnimationRecord): string {
    const stored: AnimationRecord = structuredClone(record);
    const id = stored.id || randomUUID().replace(/-/g, "").slice(0, 12);
    stored.id = id;
    if (stored.timestamp === undefined) stored.timestamp = new Date().toISOString();
    if (stored.status === undefined) stored.status = "completed";
    this.records.push(stored);
    this.save();
    return id;
  }

  /** Deep-merge `patch` into the record with `id`; return it. Throws if absent. */
  update(id: string, patch: AnimationRecord): AnimationRecord {
    for (const rec of this.records) {
      if (rec.id === id) {
        deepMerge(rec as Record<string, unknown>, structuredClone(patch) as Record<string, unknown>);
        this.save();
        return rec;
      }
    }
    throw new Error(`No record with id '${id}'`);
  }

  /** Return the record with `id`, or undefined if absent. */
  get(id: string): AnimationRecord | undefined {
    return this.records.find((rec) => rec.id === id);
  }

  /** Return the most recently added record, or undefined if empty. */
  getLast(): AnimationRecord | undefined {
    return this.records.length ? this.records[this.records.length - 1] : undefined;
  }
}
