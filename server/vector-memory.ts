// JSON-backed vector memory with cosine similarity search — port of vector_memory.py.
//
// Records are {text, meta, embedding} triples. Embeddings are produced via
// jina.embed (retrieval.passage when stored, retrieval.query when searching).
// State persists to a JSON file at storePath.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as jina from "./jina.ts";

/** One stored record. */
interface VectorRecord {
  text: string;
  meta: Record<string, unknown>;
  embedding: number[];
}

/** One scored record returned from a similarity search. */
export interface VectorMemoryResult {
  text: string;
  meta: Record<string, unknown>;
  score: number;
}

/** Cosine similarity of two vectors, or 0 if either is a zero vector. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** A small persistent store of (text, meta, embedding) records. */
export class VectorMemory {
  private records: VectorRecord[] = [];
  private dim: number | undefined;

  constructor(
    private readonly storePath: string,
    dim?: number,
  ) {
    this.dim = dim;
  }

  /** The stored records (read-only view). */
  get items(): readonly VectorRecord[] {
    return this.records;
  }

  /** Embed text (retrieval.passage) and append it with optional meta. */
  async add(text: string, meta?: Record<string, unknown>): Promise<void> {
    const vectors = await jina.embed([text], {
      task: "retrieval.passage",
      dimensions: this.dim,
    });
    const embedding = vectors[0] ?? [];
    this.records.push({ text, meta: meta ?? {}, embedding });
  }

  /** Return the top-k records most similar to query, best first. */
  async search(query: string, topK = 5): Promise<VectorMemoryResult[]> {
    if (this.records.length === 0) return [];
    const vectors = await jina.embed([query], {
      task: "retrieval.query",
      dimensions: this.dim,
    });
    const queryVec = vectors[0] ?? [];
    const scored = this.records.map((rec) => ({
      text: rec.text,
      meta: rec.meta ?? {},
      score: cosine(queryVec, rec.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Persist all records (and dim) to the JSON file at storePath. */
  save(): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const payload = { dim: this.dim ?? null, records: this.records };
    writeFileSync(this.storePath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  }

  /** Load records from the JSON file at storePath (empty if absent/invalid). */
  load(): void {
    if (!existsSync(this.storePath)) {
      this.records = [];
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(this.storePath, "utf-8"));
    } catch {
      this.records = [];
      return;
    }
    if (Array.isArray(data)) {
      this.records = data as VectorRecord[];
    } else if (data && typeof data === "object") {
      const obj = data as { records?: unknown; dim?: unknown };
      this.records = Array.isArray(obj.records) ? (obj.records as VectorRecord[]) : [];
      if (this.dim === undefined && typeof obj.dim === "number") this.dim = obj.dim;
    } else {
      this.records = [];
    }
  }
}
