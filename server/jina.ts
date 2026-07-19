// Jina web search / read / embeddings / rerank client — port of jina.py.
//
// STUB: implemented by a later track. Reads base URLs, models, and the API key
// via getJina(); the key only ever goes into the Authorization header.

export interface EmbedOptions {
  model?: string;
  task?: string;
}

/** Embed one or more texts; returns one vector per input. */
export async function embed(texts: string[], opts?: EmbedOptions): Promise<number[][]> {
  void texts;
  void opts;
  throw new Error("not implemented: jina track (jina.embed port)");
}

export interface SearchOptions {
  topN?: number;
}

/** Run a Jina web search for `query`. */
export async function search(query: string, opts?: SearchOptions): Promise<unknown[]> {
  void query;
  void opts;
  throw new Error("not implemented: jina track (jina.search port)");
}

export interface ReadOptions {
  withImages?: boolean;
}

/** Extract a page's content via the Jina reader. */
export async function read(url: string, opts?: ReadOptions): Promise<unknown> {
  void url;
  void opts;
  throw new Error("not implemented: jina track (jina.read port)");
}

export interface RerankOptions {
  model?: string;
  topN?: number;
}

/** Rerank `docs` by relevance to `query`. */
export async function rerank(query: string, docs: string[], opts?: RerankOptions): Promise<unknown[]> {
  void query;
  void docs;
  void opts;
  throw new Error("not implemented: jina track (jina.rerank port)");
}
