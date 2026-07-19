// Chat / companion routes.
//
//   GET  /api/health           implemented — proxy readiness + LLM key status
//   POST /api/chat             STUB (llm/chat track)
//   POST /api/memory/compress  STUB (llm/chat track)
//
// Security: /api/health reports only whether an LLM key is configured (boolean),
// never the value.
import type { Hono } from "hono";
import { getLlm } from "../providers.ts";
import { chat, compressMemory } from "../llm.ts";
import type { ChatOptions, CompressMemoryOptions } from "../llm.ts";

export function register(app: Hono): void {
  app.get("/api/health", (c) => {
    const llm = getLlm();
    return c.json({
      ok: true,
      apiKeyConfigured: Boolean(llm.api_key),
      model: llm.model,
      baseUrl: llm.base_url,
    });
  });

  // POST /api/chat — run a companion chat turn (system prompt + memory + tool loop).
  app.post("/api/chat", async (c) => {
    let body: ChatOptions;
    try {
      body = (await c.req.json()) as ChatOptions;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    try {
      return c.json(await chat(body));
    } catch (err) {
      return c.json({ error: `Chat failed: ${errorMessage(err)}` }, 500);
    }
  });

  // POST /api/memory/compress — compress recent turns into a relationship-diary summary.
  app.post("/api/memory/compress", async (c) => {
    let body: CompressMemoryOptions;
    try {
      body = (await c.req.json()) as CompressMemoryOptions;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    try {
      return c.json(await compressMemory(body));
    } catch (err) {
      return c.json({ error: `Memory compression failed: ${errorMessage(err)}` }, 500);
    }
  });
}

/** Extract a message string from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
