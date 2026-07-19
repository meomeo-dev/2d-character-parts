// Jina search/read + vector-memory routes.
//
//   POST /api/search           {query}          -> jina.search
//   POST /api/read             {url}            -> jina.read
//   POST /api/memory/add       {text, meta}     -> VectorMemory.add + save
//   POST /api/memory/retrieve  {query, top_k}   -> VectorMemory.search
//
// The vector store persists to config/vector_memory.json. Each request loads a
// fresh instance so concurrent handlers never share mutable in-memory state.
import type { Hono } from "hono";
import * as jina from "../jina.ts";
import { VectorMemory } from "../vector-memory.ts";
import { configPath } from "../paths.ts";

const VECTOR_STORE_PATH = configPath("vector_memory.json");

/** Extract a message string from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function register(app: Hono): void {
  // POST /api/search — {query} -> web search hits.
  app.post("/api/search", async (c) => {
    let body: { query?: unknown };
    try {
      body = (await c.req.json()) as { query?: unknown };
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const query = typeof body.query === "string" ? body.query : "";
    if (!query) return c.json({ error: "Missing 'query'" }, 400);
    try {
      return c.json({ results: await jina.search(query) });
    } catch (err) {
      return c.json({ error: `Search failed: ${errorMessage(err)}` }, 502);
    }
  });

  // POST /api/read — {url} -> extracted page content.
  app.post("/api/read", async (c) => {
    let body: { url?: unknown };
    try {
      body = (await c.req.json()) as { url?: unknown };
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const url = typeof body.url === "string" ? body.url : "";
    if (!url) return c.json({ error: "Missing 'url'" }, 400);
    try {
      return c.json({ page: await jina.read(url) });
    } catch (err) {
      return c.json({ error: `Read failed: ${errorMessage(err)}` }, 502);
    }
  });

  // POST /api/memory/add — {text, meta} -> embed and persist a record.
  app.post("/api/memory/add", async (c) => {
    let body: { text?: unknown; meta?: unknown };
    try {
      body = (await c.req.json()) as { text?: unknown; meta?: unknown };
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const text = typeof body.text === "string" ? body.text : "";
    if (!text) return c.json({ error: "Missing 'text'" }, 400);
    const meta =
      body.meta && typeof body.meta === "object" && !Array.isArray(body.meta)
        ? (body.meta as Record<string, unknown>)
        : {};
    try {
      const memory = new VectorMemory(VECTOR_STORE_PATH);
      memory.load();
      await memory.add(text, meta);
      memory.save();
      return c.json({ ok: true, count: memory.items.length });
    } catch (err) {
      return c.json({ error: `Memory add failed: ${errorMessage(err)}` }, 502);
    }
  });

  // POST /api/memory/retrieve — {query, top_k} -> nearest records.
  app.post("/api/memory/retrieve", async (c) => {
    let body: { query?: unknown; top_k?: unknown };
    try {
      body = (await c.req.json()) as { query?: unknown; top_k?: unknown };
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const query = typeof body.query === "string" ? body.query : "";
    if (!query) return c.json({ error: "Missing 'query'" }, 400);
    const topK = typeof body.top_k === "number" && body.top_k > 0 ? Math.floor(body.top_k) : 5;
    try {
      const memory = new VectorMemory(VECTOR_STORE_PATH);
      memory.load();
      return c.json({ results: await memory.search(query, topK) });
    } catch (err) {
      return c.json({ error: `Memory retrieve failed: ${errorMessage(err)}` }, 502);
    }
  });
}
