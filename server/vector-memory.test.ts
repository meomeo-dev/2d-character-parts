// Tests for server/vector-memory.ts — embedding via jina, cosine ranking, and
// JSON persistence. Global fetch is stubbed to return deterministic embeddings
// keyed by the input text, so no real network / API key is used.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorMemory } from "./vector-memory.ts";

const realFetch = globalThis.fetch;

// Deterministic 2-D embeddings per text — geometry chosen so ranking is obvious.
const EMBEDDINGS: Record<string, number[]> = {
  "cats are cute": [1, 0],
  "kittens are adorable": [0.9, 0.1],
  "the stock market fell": [0, 1],
  "felines": [1, 0],
};

function stubEmbedFetch(): void {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: string[] };
    const text = body.input[0] ?? "";
    const embedding = EMBEDDINGS[text] ?? [0, 0];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ embedding }] }),
    } as Response;
  }) as unknown as typeof fetch;
}

const tempDirs: string[] = [];
function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "vecmem-"));
  tempDirs.push(dir);
  return join(dir, "vector_memory.json");
}

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("search ranks records by cosine similarity, best first", async () => {
  stubEmbedFetch();
  const mem = new VectorMemory(tempStore());
  await mem.add("cats are cute", { topic: "pets" });
  await mem.add("the stock market fell", { topic: "finance" });
  await mem.add("kittens are adorable", { topic: "pets" });

  const results = await mem.search("felines", 2);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.text, "cats are cute");
  assert.equal(results[1]?.text, "kittens are adorable");
  assert.ok((results[0]?.score ?? 0) >= (results[1]?.score ?? 0));
  assert.deepEqual(results[0]?.meta, { topic: "pets" });
});

test("search on an empty store returns no results", async () => {
  stubEmbedFetch();
  const mem = new VectorMemory(tempStore());
  assert.deepEqual(await mem.search("felines"), []);
});

test("save then load round-trips records through the JSON file", async () => {
  stubEmbedFetch();
  const path = tempStore();
  const mem = new VectorMemory(path);
  await mem.add("cats are cute", { topic: "pets" });
  mem.save();

  const reloaded = new VectorMemory(path);
  reloaded.load();
  assert.equal(reloaded.items.length, 1);
  assert.equal(reloaded.items[0]?.text, "cats are cute");

  const results = await reloaded.search("felines", 1);
  assert.equal(results[0]?.text, "cats are cute");
});

test("load on a missing file yields an empty store", () => {
  const mem = new VectorMemory(tempStore());
  mem.load();
  assert.equal(mem.items.length, 0);
});
