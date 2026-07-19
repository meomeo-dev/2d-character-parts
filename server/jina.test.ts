// Tests for server/jina.ts — request framing and response parsing. Global fetch
// is stubbed so no real network call or API key is used.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { embed, search, read, rerank, JinaError } from "./jina.ts";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const realFetch = globalThis.fetch;

/** Stub fetch to return `responseBody` as JSON and capture the outgoing request. */
function stubFetch(responseBody: unknown, status = 200): { last: CapturedRequest | null } {
  const state: { last: CapturedRequest | null } = { last: null };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    state.last = {
      url,
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    const text = JSON.stringify(responseBody);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    } as Response;
  }) as unknown as typeof fetch;
  return state;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.JINA_API_KEY;
});

test("embed posts normalized float embeddings and returns per-input vectors", async () => {
  const state = stubFetch({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] });
  const vectors = await embed(["a", "b"]);
  assert.deepEqual(vectors, [
    [0.1, 0.2],
    [0.3, 0.4],
  ]);
  const req = state.last;
  assert.ok(req);
  assert.match(req.url, /\/embeddings$/);
  const body = req.body as Record<string, unknown>;
  assert.equal(body["model"], "jina-embeddings-v3");
  assert.equal(body["task"], "retrieval.passage");
  assert.equal(body["normalized"], true);
  assert.deepEqual(body["input"], ["a", "b"]);
});

test("search requires an API key and sends Bearer auth to the search endpoint", async () => {
  process.env.JINA_API_KEY = "secret-key";
  const state = stubFetch({ data: [{ title: "T", url: "https://x", content: "c" }] });
  const results = await search("hello");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.title, "T");
  const req = state.last;
  assert.ok(req);
  assert.equal(req.url, "https://s.jina.ai/");
  assert.deepEqual(req.body, { q: "hello" });
  assert.equal(req.headers["Authorization"], "Bearer secret-key");
});

test("search fails fast with 401 when no key is configured (no fetch call)", async () => {
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    throw new Error("should not be called");
  }) as unknown as typeof fetch;
  await assert.rejects(() => search("q"), (err: unknown) => {
    assert.ok(err instanceof JinaError);
    assert.equal(err.status, 401);
    return true;
  });
  assert.equal(fetched, false);
});

test("read sends the markdown reader header and returns the data object", async () => {
  const state = stubFetch({ data: { title: "Page", content: "# md" } });
  const page = await read("https://example.com");
  assert.equal(page.title, "Page");
  const req = state.last;
  assert.ok(req);
  assert.equal(req.url, "https://r.jina.ai/");
  assert.deepEqual(req.body, { url: "https://example.com" });
  assert.equal(req.headers["X-Respond-With"], "markdown");
});

test("rerank posts return_documents:false and returns the results array", async () => {
  const state = stubFetch({ results: [{ index: 1, relevance_score: 0.9 }] });
  const results = await rerank("q", ["d0", "d1"], { topN: 1 });
  assert.equal(results[0]?.index, 1);
  const body = state.last?.body as Record<string, unknown>;
  assert.equal(body["return_documents"], false);
  assert.equal(body["top_n"], 1);
  assert.deepEqual(body["documents"], ["d0", "d1"]);
});

test("a non-2xx response raises JinaError carrying the status", async () => {
  stubFetch({ error: "boom" }, 500);
  await assert.rejects(() => embed(["x"]), (err: unknown) => {
    assert.ok(err instanceof JinaError);
    assert.equal(err.status, 500);
    return true;
  });
});
