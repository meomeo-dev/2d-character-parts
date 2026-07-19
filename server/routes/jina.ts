// Jina search/read + vector-memory routes.
//
//   POST /api/search           STUB (jina track — server/jina.ts#search)
//   POST /api/read             STUB (jina track — server/jina.ts#read)
//   POST /api/memory/add       STUB (jina track — VectorMemory.add + save)
//   POST /api/memory/retrieve  STUB (jina track — VectorMemory.search)
import type { Hono } from "hono";

export function register(app: Hono): void {
  // TODO(jina track): {query} -> jina.search.
  app.post("/api/search", (c) => c.json({ error: "not implemented", todo: "jina track" }, 501));

  // TODO(jina track): {url} -> jina.read.
  app.post("/api/read", (c) => c.json({ error: "not implemented", todo: "jina track" }, 501));

  // TODO(jina track): {text, meta} -> VectorMemory.add + save.
  app.post("/api/memory/add", (c) => c.json({ error: "not implemented", todo: "jina track" }, 501));

  // TODO(jina track): {query, top_k} -> VectorMemory.search.
  app.post("/api/memory/retrieve", (c) =>
    c.json({ error: "not implemented", todo: "jina track" }, 501),
  );
}
