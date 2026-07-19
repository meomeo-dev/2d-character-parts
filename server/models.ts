// Model listing + strategy, ported from llm_gateway.list_models and studio's
// /api/models, /api/model-list, /api/llm-models handlers.
//
// list_models is robust against gateways that sit behind Cloudflare: it sends a
// browser-like User-Agent (the default fetch UA can trip WAF rule 1010) and an
// Authorization header when a key is configured.
import { getImage, getLlm } from "./providers.ts";

// A browser-like User-Agent. Some gateways sit behind Cloudflare, which blocks
// non-browser UAs with a 403 (error 1010); a normal UA passes.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const LIST_TIMEOUT_MS = 15_000;

/** Request headers: a browser-like UA plus Authorization when keyed. */
function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

/** Fetch JSON with a timeout, returning null on any network / parse failure. */
async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List available model IDs via GET {base_url}/models.
 *
 * Tries the base as-is, then a /v1 variant (skipped when base already ends with
 * /v1), so it works whether base_url is the proxy root or already versioned.
 * The first response carrying a non-empty `data` array wins; each entry's `id`
 * is returned. Returns [] when nothing usable is found.
 */
export async function listLlmModels(): Promise<string[]> {
  const { base_url, api_key } = getLlm();
  const base = (base_url || "").replace(/\/+$/, "");
  const headers = authHeaders(api_key);

  const candidates = [`${base}/models`];
  if (!base.endsWith("/v1")) candidates.push(`${base}/v1/models`);

  for (const url of candidates) {
    const response = await getJson(url, headers);
    if (!response || typeof response !== "object") continue;
    const data = (response as { data?: unknown }).data;
    if (Array.isArray(data) && data.length > 0) {
      const ids = data
        .map((item) =>
          item && typeof item === "object" ? (item as { id?: unknown }).id : undefined,
        )
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      if (ids.length > 0) return ids;
    }
  }
  return [];
}

export interface ModelStrategy {
  backend: string;
  root_model: string;
  ref_model: string;
  api_endpoint: string;
}

/**
 * Model strategy for the current (openai-compatible) image backend — powers
 * GET /api/models. Root and ref models are the configured image model; the
 * endpoint is derived from the image base_url.
 */
export function modelStrategy(): ModelStrategy {
  const image = getImage();
  const model = image.model || "gpt-image-1";
  const base = (image.base_url || "https://api.openai.com/v1").replace(/\/+$/, "");
  return {
    backend: "openai",
    root_model: model,
    ref_model: model,
    api_endpoint: `${base}/images/generations`,
  };
}

export interface ImageModelEntry {
  id: string;
  name: string;
}

/**
 * Image model catalog for GET /api/model-list. The frontend maps entries to
 * their `id`; this static list mirrors the Python openai backend.
 */
export function imageModelList(): { models: ImageModelEntry[] } {
  return {
    models: [
      { id: "gpt-image-1", name: "GPT Image 1" },
      { id: "gpt-image-1.5", name: "GPT Image 1.5" },
      { id: "gpt-image-2", name: "GPT Image 2" },
      { id: "gpt-image-mini", name: "GPT Image Mini" },
    ],
  };
}
