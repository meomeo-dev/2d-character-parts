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

  // TODO(llm/chat track): port chat_routes.run_chat via server/llm.ts#chat.
  app.post("/api/chat", (c) => c.json({ error: "not implemented", todo: "llm/chat track" }, 501));

  // TODO(llm/chat track): port chat_routes.run_memory_compression via server/llm.ts#compressMemory.
  app.post("/api/memory/compress", (c) =>
    c.json({ error: "not implemented", todo: "llm/chat track" }, 501),
  );
}
