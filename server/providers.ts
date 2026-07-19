// Unified provider settings for the llm / image / jina services.
//
// Load priority (highest first):
//   1. config/runtime_settings.json (if present)
//   2. environment variables
//   3. built-in defaults
//
// Runtime patches are deep-merged and persisted back to the JSON file. Only the
// override layer is written, so env-provided secrets never touch disk unless
// explicitly patched.
//
// Security: API keys are never printed to stdout or logs by this module.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "./paths.ts";

const SETTINGS_PATH = configPath("runtime_settings.json");

export interface LlmSettings {
  base_url: string;
  api_key: string;
  model: string;
}

export interface ImageSettings {
  base_url: string;
  api_key: string;
  model: string;
}

export interface JinaSettings {
  api_key: string;
  embed_model: string;
  rerank_model: string;
  reader_base: string;
  search_base: string;
  embed_base: string;
}

export interface Settings {
  llm: LlmSettings;
  image: ImageSettings;
  jina: JinaSettings;
}

/** A partial patch that may cover any subset of the settings tree. */
export type SettingsPatch = {
  llm?: Partial<LlmSettings>;
  image?: Partial<ImageSettings>;
  jina?: Partial<JinaSettings>;
};

/**
 * Built-in defaults, with env vars layered over hard-coded values.
 *
 * The llm model is an overridable placeholder; the real usable model ID is
 * discovered at runtime via GET {base_url}/models (see models.ts).
 */
function defaults(): Settings {
  return {
    llm: {
      base_url: "https://ai-gateway.vercel.sh/v1",
      api_key: process.env.AI_GATEWAY_API_KEY ?? "",
      model: "openai/gpt-5.5",
    },
    image: {
      base_url: "https://api.openai.com/v1",
      api_key: process.env.OPENAI_API_KEY ?? "",
      model: "gpt-image-1",
    },
    jina: {
      api_key: process.env.JINA_API_KEY ?? "",
      embed_model: "jina-embeddings-v3",
      rerank_model: "jina-reranker-v3",
      reader_base: "https://r.jina.ai",
      search_base: "https://s.jina.ai",
      embed_base: "https://api.jina.ai/v1",
    },
  };
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively merge patch into base in place and return base. */
function deepMerge(base: PlainObject, patch: PlainObject): PlainObject {
  for (const [key, value] of Object.entries(patch)) {
    const current = base[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      deepMerge(current, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

/** Load the persisted override layer, or an empty object if absent/invalid. */
function loadFileOverrides(): PlainObject {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Return the fully resolved settings (file > env > defaults). */
export function loadSettings(): Settings {
  const settings = defaults() as unknown as PlainObject;
  deepMerge(settings, loadFileOverrides());
  return settings as unknown as Settings;
}

/**
 * Deep-merge patch into the persisted override layer and write it back.
 *
 * Empty api_key values are allowed here (the "empty does not overwrite" rule is
 * enforced at the POST route layer, matching the Python behaviour). Returns the
 * fully resolved settings.
 */
export function saveSettings(patch: SettingsPatch): Settings {
  const overrides = deepMerge(loadFileOverrides(), structuredClone(patch) as PlainObject);
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(overrides, null, 2) + "\n", "utf-8");
  return loadSettings();
}

/** Resolved llm provider settings. */
export function getLlm(): LlmSettings {
  return loadSettings().llm;
}

/** Resolved image provider settings. */
export function getImage(): ImageSettings {
  return loadSettings().image;
}

/** Resolved jina provider settings. */
export function getJina(): JinaSettings {
  return loadSettings().jina;
}

/**
 * Return a base URL guaranteed to end with /v1, for the AI SDK openai-compatible
 * provider (which appends /chat/completions, /images/generations, /embeddings).
 *
 * When base is omitted, falls back to the resolved llm base_url. Model listing
 * does NOT use this — it probes /models and /v1/models independently (models.ts).
 */
export function llmBaseURL(base?: string): string {
  const resolved = (base ?? getLlm().base_url).replace(/\/+$/, "");
  return resolved.endsWith("/v1") ? resolved : `${resolved}/v1`;
}
