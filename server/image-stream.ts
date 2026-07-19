// Streaming image client for the OpenAI-compatible /v1/images endpoints.
//
// Why hand-rolled instead of the AI SDK: image generation on this backend can
// take 5–15 minutes, and the AI SDK's generateImage issues one blocking POST
// that waits for the whole JSON body — no way to keep the connection alive that
// long. The OpenAI image endpoints support SSE streaming (stream: true +
// partial_images), which emits `*.partial_image` events throughout the render
// so the connection never sits idle. We consume that stream and return the
// final `*.completed` image bytes.
//
// Endpoints (both verified against the configured proxy):
//   POST {base}/images/generations   JSON body        -> image_generation.*
//   POST {base}/images/edits          multipart/form   -> image_edit.*
//
// SSE event shape (per docs/image-generation-streaming.md + image-edit-streaming.md):
//   event: image_generation.partial_image | image_edit.partial_image
//     data: { type, b64_json, partial_image_index, ... }
//   event: image_generation.completed    | image_edit.completed
//     data: { type, b64_json, usage, ... }        <- final full image
//
// Node's built-in fetch (undici 6.22) defaults bodyTimeout/headersTimeout to
// 300s, which would abort a long render before the first event. We use an
// undici Agent with those timeouts disabled and rely on the SSE data flow +
// an AbortSignal for cancellation instead.
import { Agent } from "undici";

/** Base fields shared by both generation and edit requests. */
export interface StreamImageBase {
  /** Full base URL ending in /v1 (e.g. https://host/v1). */
  baseURL: string;
  apiKey: string;
  model: string;
  prompt: string;
  /** gpt-image size ("1024x1024" / "auto" / "WxH"); omitted -> provider default. */
  size?: string;
  /** Number of progressive preview frames (0–3). Kept >=1 to keep the socket busy. */
  partialImages?: number;
  /** Optional cancellation. */
  signal?: AbortSignal;
}

/** Generation-only options (text -> image). */
export type StreamGenerateOptions = StreamImageBase;

/** Edit options (reference images -> image). */
export interface StreamEditOptions extends StreamImageBase {
  /** Reference images as raw PNG/JPEG/WebP bytes; sent as repeated image[] parts. */
  images: Uint8Array[];
  /** Optional mask PNG (transparent areas = edit region). */
  mask?: Uint8Array;
  /** Fidelity to the input images ("high"/"low"); skipped for models that reject it. */
  inputFidelity?: "high" | "low";
}

/** Progress callback invoked once per partial-image frame. */
export type PartialHandler = (b64: string, index: number) => void;

// Shared body options every image request carries (quality high, keep-alive stream).
const DEFAULT_PARTIAL_IMAGES = 2;

// One long-lived dispatcher with timeouts disabled: a 5–15 min render must not
// trip undici's 300s body/headers timeout. Connection-level keep-alive is on so
// the socket stays healthy across the SSE stream.
const longRunAgent = new Agent({
  bodyTimeout: 0, // no idle-body timeout: SSE trickles for minutes
  headersTimeout: 0, // no cap on time-to-first-byte (server queues long renders)
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
});

/** Join base + path, tolerating a trailing slash on base. */
function endpoint(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, "")}${path}`;
}

/**
 * Consume an SSE image stream and resolve with the final image bytes.
 *
 * Parses `data:` lines as JSON, forwards `*.partial_image` frames to onPartial,
 * and returns the `*.completed` event's b64_json decoded to bytes. Throws if the
 * stream ends without a completed event.
 */
async function consumeImageStream(res: Response, onPartial?: PartialHandler): Promise<Uint8Array> {
  if (!res.body) throw new Error("image stream: response has no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalB64: string | null = null;

  // SSE frames are separated by a blank line; we only care about `data:` lines.
  const handleData = (payload: string): void => {
    const trimmed = payload.trim();
    if (!trimmed || trimmed === "[DONE]") return;
    let evt: { type?: string; b64_json?: string; partial_image_index?: number };
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return; // ignore keep-alive comments / malformed lines
    }
    if (!evt.type) return;
    if (evt.type.endsWith(".partial_image")) {
      if (evt.b64_json && onPartial) onPartial(evt.b64_json, evt.partial_image_index ?? 0);
    } else if (evt.type.endsWith(".completed")) {
      if (evt.b64_json) finalB64 = evt.b64_json;
    }
  };

  // Drain one buffered SSE block: concatenate its data: lines.
  const flushBlock = (block: string): void => {
    const dataLines = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length > 0) handleData(dataLines.join(""));
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    // Blocks end at a blank line (\n\n); tolerate \r\n too.
    while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
      flushBlock(block);
    }
  }
  if (buffer.trim()) flushBlock(buffer);

  if (!finalB64) {
    throw new Error("image stream ended without a completed event");
  }
  return new Uint8Array(Buffer.from(finalB64, "base64"));
}

/** Turn a non-2xx response into a concise error (surfacing proxy/API text). */
async function toError(res: Response, label: string): Promise<Error> {
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    // ignore
  }
  return new Error(`${label} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Stream a text-to-image generation and return the final PNG bytes.
 *
 * POSTs JSON to {baseURL}/images/generations with stream:true; the SSE
 * partial_image frames keep the (potentially multi-minute) connection alive.
 */
export async function streamGenerate(opts: StreamGenerateOptions, onPartial?: PartialHandler): Promise<Uint8Array> {
  const body: Record<string, unknown> = {
    model: opts.model,
    prompt: opts.prompt,
    stream: true,
    partial_images: opts.partialImages ?? DEFAULT_PARTIAL_IMAGES,
    quality: "high",
  };
  if (opts.size) body["size"] = opts.size;

  const res = await fetch(endpoint(opts.baseURL, "/images/generations"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
    // @ts-expect-error dispatcher is an undici-specific fetch option, valid at runtime.
    dispatcher: longRunAgent,
  });
  if (!res.ok) throw await toError(res, "image generation");
  return consumeImageStream(res, onPartial);
}

/**
 * Stream an image edit (img2img with reference images) and return final bytes.
 *
 * POSTs multipart/form-data to {baseURL}/images/edits with repeated image[]
 * parts and stream:true. Mask + input_fidelity are optional.
 */
export async function streamEdit(opts: StreamEditOptions, onPartial?: PartialHandler): Promise<Uint8Array> {
  if (!opts.images || opts.images.length === 0) {
    throw new Error("streamEdit requires at least one reference image");
  }
  const form = new FormData();
  form.append("model", opts.model);
  form.append("prompt", opts.prompt);
  form.append("stream", "true");
  form.append("partial_images", String(opts.partialImages ?? DEFAULT_PARTIAL_IMAGES));
  form.append("quality", "high");
  if (opts.size) form.append("size", opts.size);
  if (opts.inputFidelity) form.append("input_fidelity", opts.inputFidelity);
  for (const img of opts.images) {
    // Copy into a fresh ArrayBuffer so Blob gets exactly these bytes.
    form.append("image[]", new Blob([toArrayBuffer(img)], { type: "image/png" }), "ref.png");
  }
  if (opts.mask) {
    form.append("mask", new Blob([toArrayBuffer(opts.mask)], { type: "image/png" }), "mask.png");
  }

  const res = await fetch(endpoint(opts.baseURL, "/images/edits"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: "text/event-stream",
      // NOTE: no Content-Type — fetch sets the multipart boundary automatically.
    },
    body: form,
    signal: opts.signal,
    // @ts-expect-error dispatcher is an undici-specific fetch option, valid at runtime.
    dispatcher: longRunAgent,
  });
  if (!res.ok) throw await toError(res, "image edit");
  return consumeImageStream(res, onPartial);
}

/** Copy a Uint8Array's exact bytes into a standalone ArrayBuffer for Blob. */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}
