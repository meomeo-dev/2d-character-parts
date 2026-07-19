// Provider / config / model routes — the foundation layer (fully implemented).
//
//   GET  /api/providers    resolved llm/image/jina settings, api_key masked
//   POST /api/providers    persist a settings patch (blank api_key never overwrites)
//   POST /api/settings      legacy single-key setter -> image.api_key
//   GET  /api/config        parts_layout.json (raw)
//   GET  /api/models        current image-backend model strategy
//   GET  /api/model-list    image model catalog (frontend dropdown)
//   GET  /api/llm-models     model IDs discovered via the LLM gateway
//
// Security: api_key values are never echoed. GET /api/providers returns only a
// boolean `api_key_set` plus a last-4 `api_key_hint`.
import { readFile } from "node:fs/promises";
import type { Hono } from "hono";
import { imageModelList, listLlmModels, modelStrategy } from "../models.ts";
import { configPath } from "../paths.ts";
import { loadSettings, saveSettings, type SettingsPatch } from "../providers.ts";

type Section = "llm" | "image" | "jina";
const SECTIONS: readonly Section[] = ["llm", "image", "jina"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip api_key from a settings section, adding a masked set/hint pair. */
function mask(cfg: Record<string, unknown>): Record<string, unknown> {
  const { api_key, ...rest } = cfg as { api_key?: unknown } & Record<string, unknown>;
  const key = typeof api_key === "string" ? api_key : "";
  return {
    ...rest,
    api_key_set: key.length > 0,
    api_key_hint: key.length >= 4 ? `…${key.slice(-4)}` : key ? "set" : "",
  };
}

function maskedSettings(): Record<Section, Record<string, unknown>> {
  const settings = loadSettings();
  return {
    llm: mask(settings.llm as unknown as Record<string, unknown>),
    image: mask(settings.image as unknown as Record<string, unknown>),
    jina: mask(settings.jina as unknown as Record<string, unknown>),
  };
}

export function register(app: Hono): void {
  app.get("/api/providers", (c) => c.json(maskedSettings()));

  app.post("/api/providers", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const patch: SettingsPatch = {};
    for (const section of SECTIONS) {
      const block = isPlainObject(body) ? body[section] : undefined;
      if (!isPlainObject(block)) continue;
      const cleaned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(block)) {
        // Blank api_key is dropped so it never overwrites an existing secret.
        if (key === "api_key" && !value) continue;
        cleaned[key] = value;
      }
      if (Object.keys(cleaned).length > 0) {
        patch[section] = cleaned as SettingsPatch[Section];
      }
    }
    if (Object.keys(patch).length > 0) saveSettings(patch);

    return c.json(maskedSettings());
  });

  app.post("/api/settings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const apiKey = isPlainObject(body) ? body["api_key"] : undefined;
    if (typeof apiKey === "string" && apiKey) {
      saveSettings({ image: { api_key: apiKey } });
      return c.json({ ok: true });
    }
    return c.json({ error: "Missing api_key" }, 400);
  });

  app.get("/api/config", async (c) => {
    const raw = await readFile(configPath("parts_layout.json"), "utf-8");
    return c.body(raw, 200, { "Content-Type": "application/json; charset=utf-8" });
  });

  app.get("/api/models", (c) => c.json(modelStrategy()));

  app.get("/api/model-list", (c) => c.json(imageModelList()));

  app.get("/api/llm-models", async (c) => {
    try {
      const models = await listLlmModels();
      return c.json({ models });
    } catch (error) {
      return c.json({ models: [], error: String(error) });
    }
  });
}
