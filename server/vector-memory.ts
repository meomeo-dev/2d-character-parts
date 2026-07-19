// JSON-backed vector memory — port of vector_memory.py.
//
// STUB: implemented by a later track. Embeds text via jina.embed, persists
// records to a JSON file, and retrieves by cosine similarity.

/** One scored record returned from a similarity search. */
export interface VectorMemoryResult {
  text: string;
  meta: Record<string, unknown>;
  score: number;
}

export class VectorMemory {
  constructor(private readonly storePath: string) {}

  /** Embed `text` and append it (with optional metadata) to the store. */
  async add(text: string, meta?: Record<string, unknown>): Promise<void> {
    void text;
    void meta;
    void this.storePath;
    throw new Error("not implemented: vector-memory track (VectorMemory.add port)");
  }

  /** Return the top-k records most similar to `query`. */
  async search(query: string, topK?: number): Promise<VectorMemoryResult[]> {
    void query;
    void topK;
    throw new Error("not implemented: vector-memory track (VectorMemory.search port)");
  }

  /** Persist the in-memory records to disk. */
  save(): void {
    throw new Error("not implemented: vector-memory track (VectorMemory.save port)");
  }

  /** Load persisted records from disk (no-op when the file is absent). */
  load(): void {
    throw new Error("not implemented: vector-memory track (VectorMemory.load port)");
  }
}
