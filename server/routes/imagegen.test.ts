// Route tests for POST /api/generate and POST /api/matting.
//
// The network-facing image-gen module, the matting stub, and the filesystem
// paths are all mocked, so no real API key / network / repo dirs are touched.
// Run: node --import tsx --experimental-test-module-mocks --test server/routes/imagegen.test.ts
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Hono } from "hono";

const SERVER_DIR = join(import.meta.dirname, "..");
const url = (rel: string) => pathToFileURL(join(SERVER_DIR, rel)).href;

// Tmp workspace standing in for the worktree root.
const TMP = mkdtempSync(join(tmpdir(), "track-g-imagegen-"));
const PARTS_DIR = join(TMP, "parts");
const REAL_CONFIG = join(SERVER_DIR, "..", "config");

// Recorded calls into the mocked image-gen module.
interface Call {
  fn: "generate" | "edit";
  prompt: string;
  images?: Array<string | Uint8Array>;
  size?: string;
  model?: string;
}
const calls: Call[] = [];
const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const FAKE_TRANSPARENT = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
const mattingCalls: Array<{ white: Buffer; black: Buffer }> = [];

let register: (app: Hono) => void;

before(async () => {
  mock.module(url("paths.ts"), {
    namedExports: {
      ROOT: TMP,
      CONFIG_DIR: REAL_CONFIG,
      TEMPLATES_DIR: join(TMP, "templates"),
      PARTS_DIR,
      ANIMATIONS_DIR: join(TMP, "animations"),
      configPath: (...s: string[]) => join(REAL_CONFIG, ...s),
      templatesPath: (...s: string[]) => join(TMP, "templates", ...s),
      partsPath: (...s: string[]) => join(PARTS_DIR, ...s),
      animationsPath: (...s: string[]) => join(TMP, "animations", ...s),
    },
  });
  mock.module(url("image-gen.ts"), {
    namedExports: {
      toOpenAISize: (imageSize?: string | null, aspectRatio?: string | null) =>
        aspectRatio ?? imageSize ?? "auto",
      generateImage: async (opts: { prompt: string; size?: string; model?: string }) => {
        calls.push({ fn: "generate", prompt: opts.prompt, size: opts.size, model: opts.model });
        return FAKE_PNG;
      },
      editImage: async (opts: {
        prompt: string;
        images: Array<string | Uint8Array>;
        size?: string;
        model?: string;
      }) => {
        calls.push({ fn: "edit", prompt: opts.prompt, images: opts.images, size: opts.size, model: opts.model });
        return FAKE_PNG;
      },
    },
  });
  mock.module(url("image/matting.ts"), {
    namedExports: {
      triangulationMatting: async (white: Buffer, black: Buffer) => {
        mattingCalls.push({ white, black });
        return FAKE_TRANSPARENT;
      },
    },
  });

  ({ register } = await import(url("./routes/imagegen.ts")));
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function app(): Hono {
  const a = new Hono();
  register(a);
  return a;
}

async function post(a: Hono, path: string, body: unknown): Promise<Response> {
  return a.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /api/generate without refs calls generateImage and writes parts/<id>.png", async () => {
  calls.length = 0;
  const res = await post(app(), "/api/generate", { part_id: "torso", positive: "a torso", image_size: "1024x1024" });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Record<string, unknown>;
  assert.equal(json["ok"], true);
  assert.equal(json["part_id"], "torso");
  assert.equal(json["url"], "/parts/torso.png");
  assert.ok(typeof json["timing_ms"] === "number");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.fn, "generate");
  assert.ok(existsSync(join(PARTS_DIR, "torso.png")));
  assert.deepEqual(new Uint8Array(readFileSync(join(PARTS_DIR, "torso.png"))), FAKE_PNG);
});

test("POST /api/generate with refs calls editImage and returns ref_meta", async () => {
  calls.length = 0;
  mkdirSync(PARTS_DIR, { recursive: true });
  writeFileSync(join(PARTS_DIR, "head.png"), Buffer.from(FAKE_PNG));
  const res = await post(app(), "/api/generate", {
    part_id: "torso",
    positive: "a torso",
    ref_images: ["/parts/head.png"],
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Record<string, unknown>;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.fn, "edit");
  // The resolved ref is passed to editImage as an absolute path under PARTS_DIR.
  assert.equal(calls[0]!.images!.length, 1);
  assert.equal(calls[0]!.images![0], join(PARTS_DIR, "head.png"));
  const refMeta = json["ref_meta"] as Array<Record<string, unknown>>;
  assert.equal(refMeta.length, 1);
  assert.equal(refMeta[0]!["part_id"], "head");
  assert.equal(refMeta[0]!["idx"], 1);
  // Guidance text is appended to the returned prompt.
  assert.ok(String(json["prompt"]).includes("参考图使用指南"));
});

test("POST /api/generate rejects missing positive", async () => {
  const res = await post(app(), "/api/generate", { part_id: "torso" });
  assert.equal(res.status, 400);
});

test("POST /api/generate rejects invalid JSON", async () => {
  const res = await app().request("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
});

test("POST /api/matting produces white/black/transparent and calls triangulationMatting", async () => {
  calls.length = 0;
  mattingCalls.length = 0;
  mkdirSync(PARTS_DIR, { recursive: true });
  // Build a real 1:1 PNG so the sharp metadata read succeeds.
  const sharp = (await import("sharp")).default;
  const png = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  writeFileSync(join(PARTS_DIR, "leg.png"), png);

  const res = await post(app(), "/api/matting", { part_id: "leg" });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Record<string, unknown>;
  assert.equal(json["transparent_url"], "/parts/leg.png");
  assert.equal(json["white_url"], "/parts/leg_white.png");

  assert.ok(existsSync(join(PARTS_DIR, "leg_white.png")));
  assert.ok(existsSync(join(PARTS_DIR, "leg_black.png")));
  // Black bg produced via a single editImage call on the white image.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.fn, "edit");
  // Matting was invoked and its output overwrote the current part.
  assert.equal(mattingCalls.length, 1);
  assert.deepEqual(new Uint8Array(readFileSync(join(PARTS_DIR, "leg.png"))), new Uint8Array(FAKE_TRANSPARENT));
});

test("POST /api/matting rejects when part not generated yet", async () => {
  const res = await post(app(), "/api/matting", { part_id: "missing_part" });
  assert.equal(res.status, 400);
});
