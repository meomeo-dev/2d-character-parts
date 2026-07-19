// Image generation + editing via the streaming /v1/images endpoints.
//
// Renders can take 5–15 minutes, so we stream (stream: true + partial_images)
// rather than issuing one blocking request — the SSE partial frames keep the
// connection alive and we return the final `*.completed` image. See
// server/image-stream.ts and docs/image-{generation,edit}-streaming.md.
//
// The exported generate/edit/toOpenAISize signatures are unchanged from the
// previous AI-SDK-based implementation, so callers and tests are unaffected.
import { readFileSync } from "node:fs";
import { getImage, llmBaseURL } from "./providers.ts";
import { streamGenerate, streamEdit } from "./image-stream.ts";

/** Valid gpt-image `size` values for the fixed-size providers. */
const OPENAI_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536", "auto"]);

/**
 * Map a frontend size / aspect ratio to a valid gpt-image `size`.
 *
 * Accepts an explicit gpt-image size ("1024x1024"/"auto"), an aspect-ratio
 * string ("9:16"), or a "WxH" dimension string, and collapses each to the
 * nearest supported value. Falls back to "auto" when the ratio is unknown.
 * Port of studio.to_openai_size.
 */
export function toOpenAISize(imageSize?: string | null, aspectRatio?: string | null): string {
  if (typeof imageSize === "string" && OPENAI_SIZES.has(imageSize)) {
    return imageSize;
  }

  let ratio: number | null = null;
  if (typeof aspectRatio === "string" && aspectRatio.includes(":")) {
    ratio = ratioFromPair(aspectRatio, ":");
  }
  if (ratio === null && typeof imageSize === "string" && imageSize.toLowerCase().includes("x")) {
    ratio = ratioFromPair(imageSize.toLowerCase(), "x");
  }

  if (ratio === null) return "auto";
  if (ratio > 1.1) return "1536x1024";
  if (ratio < 0.9) return "1024x1536";
  return "1024x1024";
}

/** Parse `"<w><sep><h>"` into `w / h`, or null when malformed. */
function ratioFromPair(text: string, sep: string): number | null {
  const parts = text.split(sep);
  if (parts.length !== 2) return null;
  const w = Number(parts[0]);
  const h = Number(parts[1]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return w / h;
}

/** Resolve the image provider into the fields the stream client needs. */
function imageConfig(model?: string): { baseURL: string; apiKey: string; model: string } {
  const image = getImage();
  return {
    baseURL: llmBaseURL(image.base_url),
    apiKey: image.api_key,
    model: model && model.length > 0 ? model : image.model,
  };
}

/** Options for a text-to-image generation. */
export interface GenerateImageOptions {
  prompt: string;
  size?: string;
  model?: string;
  signal?: AbortSignal;
}

/** Generate an image from a prompt and return the raw PNG bytes. */
export async function generateImage(opts: GenerateImageOptions): Promise<Uint8Array> {
  const cfg = imageConfig(opts.model);
  return streamGenerate({
    ...cfg,
    prompt: opts.prompt,
    size: toOpenAISize(opts.size),
    signal: opts.signal,
  });
}

/** Options for an image edit — one or more reference inputs (paths or bytes). */
export interface EditImageOptions {
  prompt: string;
  images: Array<string | Uint8Array>;
  size?: string;
  model?: string;
  signal?: AbortSignal;
}

/**
 * Edit/compose an image against reference inputs and return the raw PNG bytes.
 *
 * String inputs are treated as filesystem paths and read into bytes here;
 * `Uint8Array` inputs are passed through as-is.
 */
export async function editImage(opts: EditImageOptions): Promise<Uint8Array> {
  if (!opts.images || opts.images.length === 0) {
    throw new Error("editImage() requires at least one image");
  }
  const images: Uint8Array[] = opts.images.map((src) =>
    typeof src === "string" ? new Uint8Array(readFileSync(src)) : src,
  );
  const cfg = imageConfig(opts.model);
  return streamEdit({
    ...cfg,
    prompt: opts.prompt,
    images,
    size: opts.size ? toOpenAISize(opts.size) : undefined,
    signal: opts.signal,
  });
}
