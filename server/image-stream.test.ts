// Tests for the transient-failure retry in streamGenerate / streamEdit.
//
// We stub globalThis.fetch to script per-attempt outcomes (throw a transient
// error, return an HTTP error, or return a good SSE stream) and assert that:
//   - a transient blip is retried and then succeeds,
//   - a deterministic 4xx (model rejection) is NOT retried,
//   - a 5xx is retried, exhausting attempts,
//   - a user abort is not retried.
// _retryConfig.baseDelayMs is set to 0 so backoff doesn't slow the suite.
// Run: node --import tsx --test server/image-stream.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { streamGenerate, streamEdit, _retryConfig } from "./image-stream.ts";

const BASE = { baseURL: "https://proxy.test/v1", apiKey: "k", model: "gpt-image-2", prompt: "a cat" };
const EDIT = { ...BASE, images: [new Uint8Array([1, 2, 3, 4])] };

// A 1x1 transparent PNG, base64 — the bytes a completed event would carry.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A Response whose body streams one partial + one completed SSE event. */
function sseResponse(): Response {
  const frames = [
    `event: image_generation.partial_image\ndata: ${JSON.stringify({ type: "image_generation.partial_image", b64_json: PNG_B64, partial_image_index: 0 })}\n\n`,
    `event: image_generation.completed\ndata: ${JSON.stringify({ type: "image_generation.completed", b64_json: PNG_B64 })}\n\n`,
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** An HTTP error Response with a text body (mimics the proxy's error JSON). */
function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status });
}

/** A one-shot JSON response (proxy ignored stream:true), Content-Type json. */
function jsonImageResponse(data: unknown): Response {
  return new Response(JSON.stringify({ id: "img_x", created: 1, data }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** A raw PNG-bytes response (what downloading a data[].url returns). */
function pngBytesResponse(): Response {
  return new Response(Buffer.from(PNG_B64, "base64"), {
    status: 200,
    headers: { "Content-Type": "image/png" },
  });
}

/** A transient undici-style failure: TypeError("fetch failed") + cause.code. */
function transientError(code = "ECONNRESET"): TypeError {
  const e = new TypeError("fetch failed");
  (e as { cause?: unknown }).cause = { code };
  return e;
}

let realFetch: typeof globalThis.fetch;
let realDelay: number;
let calls: number;

/** Install a fetch stub that plays `outcomes` in order (one per attempt). */
function scriptFetch(outcomes: Array<() => Promise<Response> | Response>): void {
  calls = 0;
  globalThis.fetch = (async () => {
    const outcome = outcomes[Math.min(calls, outcomes.length - 1)]!;
    calls++;
    return outcome();
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  realDelay = _retryConfig.baseDelayMs;
  _retryConfig.baseDelayMs = 0; // no real backoff waits in tests
});

afterEach(() => {
  globalThis.fetch = realFetch;
  _retryConfig.baseDelayMs = realDelay;
});

test("streamGenerate: transient failure then success (retries once)", async () => {
  scriptFetch([
    () => { throw transientError("ECONNRESET"); },
    () => sseResponse(),
  ]);
  const bytes = await streamGenerate(BASE);
  assert.equal(calls, 2, "should have retried exactly once");
  assert.ok(bytes.length > 0, "returns decoded image bytes");
});

test("streamGenerate: transient failures exhaust maxAttempts then throw", async () => {
  scriptFetch([() => { throw transientError("ETIMEDOUT"); }]);
  await assert.rejects(() => streamGenerate(BASE), /fetch failed/);
  assert.equal(calls, _retryConfig.maxAttempts, "tries exactly maxAttempts times");
});

test("streamGenerate: HTTP 400 model rejection is NOT retried", async () => {
  scriptFetch([() => errorResponse(400, "Transparent background is not supported for this model.")]);
  await assert.rejects(() => streamGenerate(BASE), /HTTP 400.*Transparent background/s);
  assert.equal(calls, 1, "4xx is deterministic — no retry");
});

test("streamGenerate: HTTP 500 is retried (transient upstream)", async () => {
  scriptFetch([() => errorResponse(500, "bad gateway")]);
  await assert.rejects(() => streamGenerate(BASE), /HTTP 500/);
  assert.equal(calls, _retryConfig.maxAttempts, "5xx retried up to maxAttempts");
});

test("streamGenerate: HTTP 429 is retried then succeeds", async () => {
  scriptFetch([
    () => errorResponse(429, "rate limited"),
    () => sseResponse(),
  ]);
  const bytes = await streamGenerate(BASE);
  assert.equal(calls, 2);
  assert.ok(bytes.length > 0);
});

test("streamGenerate: aborted signal is not retried", async () => {
  const ac = new AbortController();
  ac.abort();
  scriptFetch([() => { const e = new Error("The operation was aborted"); e.name = "AbortError"; throw e; }]);
  await assert.rejects(() => streamGenerate({ ...BASE, signal: ac.signal }), /aborted/i);
  assert.equal(calls, 1, "abort is never retried");
});

test("streamEdit: rebuilds multipart body and retries transient failure", async () => {
  scriptFetch([
    () => { throw transientError("UND_ERR_SOCKET"); },
    () => sseResponse(),
  ]);
  const bytes = await streamEdit(EDIT);
  assert.equal(calls, 2);
  assert.ok(bytes.length > 0);
});

// ── Non-streaming fallback (proxy ignores stream:true, returns JSON) ─────────

test("streamGenerate: non-stream JSON with b64_json is decoded (no retry)", async () => {
  scriptFetch([() => jsonImageResponse([{ b64_json: PNG_B64 }])]);
  const bytes = await streamGenerate(BASE);
  assert.equal(calls, 1, "inline b64 needs a single call");
  assert.ok(bytes.length > 0, "decodes the base64 image");
});

test("streamGenerate: non-stream JSON with url downloads the image", async () => {
  scriptFetch([
    () => jsonImageResponse([{ url: "https://file.test/img.png" }]),
    () => pngBytesResponse(), // the follow-up download
  ]);
  const bytes = await streamGenerate(BASE);
  assert.equal(calls, 2, "one generate call + one download");
  assert.ok(bytes.length > 0);
});

test("streamGenerate: non-stream JSON with empty data throws and is NOT retried", async () => {
  scriptFetch([() => jsonImageResponse([{}])]);
  await assert.rejects(() => streamGenerate(BASE), /no b64_json or url/);
  assert.equal(calls, 1, "a shape error won't change on retry");
});

test("streamGenerate: url download retries a transient failure then succeeds", async () => {
  scriptFetch([
    () => jsonImageResponse([{ url: "https://file.test/img.png" }]),
    () => { throw transientError("ECONNRESET"); }, // download blips once
    () => jsonImageResponse([{ url: "https://file.test/img.png" }]), // retry: generate again
    () => pngBytesResponse(), // download succeeds
  ]);
  const bytes = await streamGenerate(BASE);
  assert.ok(bytes.length > 0);
  assert.equal(calls, 4, "generate+failed-download, then generate+download");
});

test("streamEdit: non-stream JSON fallback also works", async () => {
  scriptFetch([() => jsonImageResponse([{ b64_json: PNG_B64 }])]);
  const bytes = await streamEdit(EDIT);
  assert.equal(calls, 1);
  assert.ok(bytes.length > 0);
});
