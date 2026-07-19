// Image generation + editing via the AI SDK.
//
// Ports image_openai.generate / .edit and the studio `_generate_openai` /
// `_black_bg_via_openai` paths onto the openai-compatible image model.
//
// Backend choice (edits): the AI SDK v7 `generateImage` DOES support reference
// inputs — pass `prompt: { text, images: [...] }` and the openai-compatible
// `imageModel` routes it to `POST {baseURL}/images/edits` as multipart
// (model / prompt / image[] / size), exactly like image_openai.edit. So there is
// no need for a hand-rolled multipart fetch; both text-to-image and img2img go
// through `generateImage`. The provider `size` param is `${w}x${h}`-typed and
// rejects "auto", so we pass size (and quality) through `providerOptions.image`
// instead — those land in the request body verbatim, and "auto" is a valid
// gpt-image size.
import { readFileSync } from "node:fs";
import { generateImage as aiGenerateImage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getImage, llmBaseURL } from "./providers.ts";

/** Valid gpt-image `size` values. */
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

/** Build the openai-compatible image model from the resolved image provider. */
function imageModel(model?: string) {
  const image = getImage();
  const provider = createOpenAICompatible({
    name: "image",
    baseURL: llmBaseURL(image.base_url),
    apiKey: image.api_key,
  });
  return provider.imageModel(model && model.length > 0 ? model : image.model);
}

/** Provider body options shared by generate + edit (keyed by the provider name). */
function imageProviderOptions(size?: string): { image: Record<string, string> } {
  const opts: Record<string, string> = { quality: "high" };
  if (size) opts["size"] = size;
  return { image: opts };
}

/** Options for a text-to-image generation. */
export interface GenerateImageOptions {
  prompt: string;
  size?: string;
  model?: string;
}

/** Generate an image from a prompt and return the raw PNG bytes. */
export async function generateImage(opts: GenerateImageOptions): Promise<Uint8Array> {
  const size = toOpenAISize(opts.size);
  const result = await aiGenerateImage({
    model: imageModel(opts.model),
    prompt: opts.prompt,
    providerOptions: imageProviderOptions(size),
  });
  return result.image.uint8Array;
}

/** Options for an image edit — one or more reference inputs (paths or bytes). */
export interface EditImageOptions {
  prompt: string;
  images: Array<string | Uint8Array>;
  size?: string;
  model?: string;
}

/**
 * Edit/compose an image against reference inputs and return the raw PNG bytes.
 *
 * String inputs are treated as filesystem paths and read into bytes here (the
 * SDK would otherwise interpret a bare string as base64); `Uint8Array` inputs
 * are passed through as-is.
 */
export async function editImage(opts: EditImageOptions): Promise<Uint8Array> {
  if (!opts.images || opts.images.length === 0) {
    throw new Error("editImage() requires at least one image");
  }
  const images: Uint8Array[] = opts.images.map((src) =>
    typeof src === "string" ? new Uint8Array(readFileSync(src)) : src,
  );
  const size = opts.size ? toOpenAISize(opts.size) : undefined;
  const result = await aiGenerateImage({
    model: imageModel(opts.model),
    prompt: { text: opts.prompt, images },
    providerOptions: imageProviderOptions(size),
  });
  return result.image.uint8Array;
}
