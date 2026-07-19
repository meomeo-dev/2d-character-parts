// Jina AI client — embeddings, web search, reader, and reranking.
//
// Port of scripts/jina.py. Thin wrappers over the Jina REST APIs. Provider
// defaults (API key, model names, base URLs) come from getJina(); callers may
// override any of them per call.
//
// Security: the API key is only ever placed in the Authorization header and is
// never logged or echoed by this module. Requests carry a browser-like
// User-Agent so gateways behind a WAF (Cloudflare rule 1010) don't reject them.
import { getJina } from "./providers.ts";

const DEFAULT_EMBED_MODEL = "jina-embeddings-v3";
const DEFAULT_RERANK_MODEL = "jina-reranker-v3";
const DEFAULT_EMBED_BASE = "https://api.jina.ai/v1";
const DEFAULT_SEARCH_BASE = "https://s.jina.ai";
const DEFAULT_READER_BASE = "https://r.jina.ai";

// A browser-like User-Agent. Some gateways sit behind Cloudflare, which blocks
// non-browser UAs with a 403 (error 1010); a normal UA passes.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** Raised when a Jina request fails; status 0 means a connection-level error. */
export class JinaError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body}`);
    this.name = "JinaError";
  }
}

/** Join base and path with exactly one slash between them. */
function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

/** Return the explicit key when given, else the provider default. */
function resolveKey(apiKey: string | undefined, fallback: string): string {
  return apiKey !== undefined ? apiKey : fallback;
}

/** Build request headers: Accept JSON, browser UA, and Bearer auth when keyed. */
function authHeaders(apiKey: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  if (extra) Object.assign(headers, extra);
  return headers;
}

/** POST a JSON payload and parse the JSON response body, throwing JinaError on failure. */
async function postJson(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new JinaError(0, err instanceof Error ? err.message : String(err));
  }
  const text = await response.text();
  if (!response.ok) throw new JinaError(response.status, text);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new JinaError(0, `Invalid JSON response: ${text.slice(0, 200)}`);
  }
}

export interface EmbedOptions {
  /** Embedding model id; defaults to the configured jina embed_model. */
  model?: string;
  /** Embedding task — "retrieval.passage" for stored docs, "retrieval.query" for queries. */
  task?: string;
  /** Optional output-vector truncation. */
  dimensions?: number;
  /** Per-call API key override. */
  apiKey?: string;
}

/**
 * Return an embedding vector for each input text.
 *
 * POSTs to {embed_base}/embeddings with normalized float embeddings and the
 * given task. Port of jina.embed.
 */
export async function embed(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
  const settings = getJina();
  const key = resolveKey(opts.apiKey, settings.api_key);
  const base = settings.embed_base || DEFAULT_EMBED_BASE;
  const payload: Record<string, unknown> = {
    model: opts.model || settings.embed_model || DEFAULT_EMBED_MODEL,
    task: opts.task ?? "retrieval.passage",
    input: texts,
    normalized: true,
    embedding_type: "float",
  };
  if (opts.dimensions !== undefined) payload["dimensions"] = opts.dimensions;
  const resp = await postJson(joinUrl(base, "embeddings"), payload, authHeaders(key));
  const data = Array.isArray(resp["data"]) ? (resp["data"] as unknown[]) : [];
  return data.map((item) => {
    const embedding = (item as { embedding?: unknown }).embedding;
    return Array.isArray(embedding) ? (embedding as number[]) : [];
  });
}

export interface SearchOptions {
  /** Cap the number of returned hits. */
  topN?: number;
  /** Per-call API key override. */
  apiKey?: string;
}

export interface SearchResult {
  title?: string;
  url?: string;
  content?: string;
  description?: string;
  [key: string]: unknown;
}

/**
 * Web search via s.jina.ai; returns [{title, url, content, description}].
 *
 * A Bearer API key is required — the endpoint returns 401 without one, so this
 * fails fast rather than making a doomed call. Port of jina.search.
 */
export async function search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
  const settings = getJina();
  const key = resolveKey(opts.apiKey, settings.api_key);
  if (!key) throw new JinaError(401, "Jina search requires an API key (set JINA_API_KEY).");
  const base = settings.search_base || DEFAULT_SEARCH_BASE;
  const resp = await postJson(joinUrl(base, ""), { q: query }, authHeaders(key));
  const data = Array.isArray(resp["data"]) ? (resp["data"] as SearchResult[]) : [];
  return opts.topN !== undefined ? data.slice(0, opts.topN) : data;
}

export interface ReadOptions {
  /** Reader output format; "markdown" by default. */
  respondWith?: string;
  /** Append a link summary to the extracted content. */
  withLinks?: boolean;
  /** Per-call API key override. */
  apiKey?: string;
}

export interface ReadResult {
  title?: string;
  url?: string;
  content?: string;
  [key: string]: unknown;
}

/**
 * Read/extract a URL's content via r.jina.ai; returns {title, url, content, ...}.
 *
 * The API key is optional for the reader. Port of jina.read.
 */
export async function read(url: string, opts: ReadOptions = {}): Promise<ReadResult> {
  const settings = getJina();
  const key = resolveKey(opts.apiKey, settings.api_key);
  const base = settings.reader_base || DEFAULT_READER_BASE;
  const extra: Record<string, string> = { "X-Respond-With": opts.respondWith ?? "markdown" };
  if (opts.withLinks) extra["X-With-Links-Summary"] = "true";
  const resp = await postJson(joinUrl(base, ""), { url }, authHeaders(key, extra));
  const data = resp["data"];
  return data && typeof data === "object" ? (data as ReadResult) : {};
}

export interface RerankOptions {
  /** Reranker model id; defaults to the configured jina rerank_model. */
  model?: string;
  /** Cap the number of returned results. */
  topN?: number;
  /** Per-call API key override. */
  apiKey?: string;
}

export interface RerankResult {
  index: number;
  relevance_score: number;
  [key: string]: unknown;
}

/**
 * Rerank documents against query; returns scored, ordered results.
 *
 * POSTs to {embed_base}/rerank with return_documents:false. Port of jina.rerank.
 */
export async function rerank(
  query: string,
  documents: string[],
  opts: RerankOptions = {},
): Promise<RerankResult[]> {
  const settings = getJina();
  const key = resolveKey(opts.apiKey, settings.api_key);
  const base = settings.embed_base || DEFAULT_EMBED_BASE;
  const payload: Record<string, unknown> = {
    model: opts.model || settings.rerank_model || DEFAULT_RERANK_MODEL,
    query,
    documents,
    return_documents: false,
  };
  if (opts.topN !== undefined) payload["top_n"] = opts.topN;
  const resp = await postJson(joinUrl(base, "rerank"), payload, authHeaders(key));
  return Array.isArray(resp["results"]) ? (resp["results"] as RerankResult[]) : [];
}
