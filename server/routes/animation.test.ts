// Route tests for POST /api/animate and GET /api/animations.
//
// The image/animation helpers, the LLM chat stub, image-gen, and filesystem
// paths are mocked, so no real API key / network / repo dirs are touched.
// Run: node --import tsx --experimental-test-module-mocks --test server/routes/animation.test.ts
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Hono } from "hono";

const SERVER_DIR = join(import.meta.dirname, "..");
const url = (rel: string) => pathToFileURL(join(SERVER_DIR, rel)).href;

const TMP = mkdtempSync(join(tmpdir(), "track-g-anim-"));
const ANIMATIONS_DIR = join(TMP, "animations");

// Recorded interactions with the mocked collaborators.
const chatCalls: unknown[] = [];
const buildPromptCalls: unknown[] = [];
const editCalls: Array<{ prompt: string; images: Array<string | Uint8Array> }> = [];
let sliceCalls = 0;

const FAKE_GRID = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
const FAKE_SHEET = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2]);
const FAKE_GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // "GIF89a"

let register: (app: Hono) => void;

before(async () => {
  mock.module(url("paths.ts"), {
    namedExports: {
      ROOT: TMP,
      CONFIG_DIR: join(TMP, "config"),
      TEMPLATES_DIR: join(TMP, "templates"),
      PARTS_DIR: join(TMP, "parts"),
      ANIMATIONS_DIR,
      configPath: (...s: string[]) => join(TMP, "config", ...s),
      templatesPath: (...s: string[]) => join(TMP, "templates", ...s),
      partsPath: (...s: string[]) => join(TMP, "parts", ...s),
      animationsPath: (...s: string[]) => join(ANIMATIONS_DIR, ...s),
    },
  });
  mock.module(url("llm.ts"), {
    namedExports: {
      chat: async (opts: unknown) => {
        chatCalls.push(opts);
        return { assistantMessage: "a brave knight swinging a sword", reasoningContent: "", effects: [], usage: {} };
      },
    },
  });
  mock.module(url("image/animation.ts"), {
    namedExports: {
      createGrid: async (rows: number, cols: number, width: number) => {
        void rows;
        void cols;
        void width;
        return { png: FAKE_GRID, w: width, h: width };
      },
      buildPrompt: (description: string, rows: number, cols: number, opts: unknown) => {
        buildPromptCalls.push({ description, rows, cols, opts });
        return `PROMPT<${description}|${rows}x${cols}>`;
      },
      sliceAndGif: async () => {
        sliceCalls += 1;
        return FAKE_GIF;
      },
    },
  });
  mock.module(url("image-gen.ts"), {
    namedExports: {
      toOpenAISize: () => "auto",
      generateImage: async () => FAKE_SHEET,
      editImage: async (opts: { prompt: string; images: Array<string | Uint8Array> }) => {
        editCalls.push({ prompt: opts.prompt, images: opts.images });
        return FAKE_SHEET;
      },
    },
  });

  ({ register } = await import(url("./routes/animation.ts")));
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

function reset(): void {
  chatCalls.length = 0;
  buildPromptCalls.length = 0;
  editCalls.length = 0;
  sliceCalls = 0;
}

test("POST /api/animate with description runs grid->sheet->gif and persists a record", async () => {
  reset();
  const res = await post(app(), "/api/animate", {
    description: "a knight",
    rows: 3,
    cols: 4,
    style: "pixel art",
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Record<string, unknown>;

  // idea absent -> no LLM expansion.
  assert.equal(chatCalls.length, 0);
  // buildPrompt got the raw description and clamped dims.
  assert.equal(buildPromptCalls.length, 1);
  // Sheet generated via editImage on the grid template, then sliced to a GIF.
  assert.equal(editCalls.length, 1);
  assert.equal(editCalls[0]!.images.length, 1);
  assert.equal(sliceCalls, 1);

  // URLs + record surfaced.
  assert.match(String(json["gif_url"]), /^\/animations\/anim_3x4_.*\.gif$/);
  assert.match(String(json["sheet_url"]), /^\/animations\/sheet_3x4_.*\.png$/);
  const record = json["record"] as Record<string, unknown>;
  assert.equal(record["description"], "a knight");
  assert.equal(record["generation_mode"], "new");
  assert.ok(typeof record["id"] === "string");

  // Files landed under animations/ and history.json was written.
  const sheetName = String(json["sheet_url"]).replace("/animations/", "");
  const gifName = String(json["gif_url"]).replace("/animations/", "");
  assert.ok(existsSync(join(ANIMATIONS_DIR, sheetName)));
  assert.ok(existsSync(join(ANIMATIONS_DIR, gifName)));
  assert.deepEqual(new Uint8Array(readFileSync(join(ANIMATIONS_DIR, sheetName))), FAKE_SHEET);
  assert.deepEqual(new Uint8Array(readFileSync(join(ANIMATIONS_DIR, gifName))), new Uint8Array(FAKE_GIF));
  assert.ok(existsSync(join(ANIMATIONS_DIR, "history.json")));
});

test("POST /api/animate with idea expands it via the LLM", async () => {
  reset();
  const res = await post(app(), "/api/animate", { idea: "骑士挥剑", rows: 2, cols: 2 });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Record<string, unknown>;
  assert.equal(chatCalls.length, 1);
  const record = json["record"] as Record<string, unknown>;
  assert.equal(record["description"], "a brave knight swinging a sword");
  assert.equal(record["idea"], "骑士挥剑");
});

test("POST /api/animate rejects when neither idea nor description given", async () => {
  reset();
  const res = await post(app(), "/api/animate", { rows: 3, cols: 3 });
  assert.equal(res.status, 400);
});

test("GET /api/animations lists persisted records with URLs", async () => {
  // Prior tests already added records to the shared store file.
  const res = await app().request("/api/animations");
  assert.equal(res.status, 200);
  const json = (await res.json()) as { records: Array<Record<string, unknown>> };
  assert.ok(json.records.length >= 2);
  for (const r of json.records) {
    assert.ok(typeof r["id"] === "string");
    assert.match(String(r["sheet_url"]), /^\/animations\//);
  }
});

test("POST /api/animate passes ref parts first and the grid template last, in order", async () => {
  reset();
  const partsDir = join(TMP, "parts");
  mkdirSync(partsDir, { recursive: true });
  for (const id of ["head", "torso", "hand_L"]) {
    writeFileSync(join(partsDir, `${id}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }
  // A ref id with no PNG is dropped (not sent to editImage).
  const res = await post(app(), "/api/animate", {
    description: "a knight",
    rows: 2,
    cols: 2,
    ref_parts: ["torso", "head", "missing_part", "hand_L"],
  });
  assert.equal(res.status, 200);
  assert.equal(editCalls.length, 1);
  const images = editCalls[0]!.images as string[];
  // parts (existing, in selection order) first, template last.
  assert.equal(images.length, 4); // torso, head, hand_L, template
  assert.equal(images[0], join(partsDir, "torso.png"));
  assert.equal(images[1], join(partsDir, "head.png"));
  assert.equal(images[2], join(partsDir, "hand_L.png"));
  assert.match(images[3]!, /grid_2x2_.*\.png$/); // template is last

  // buildPrompt received labels in the same order (ids, since config is absent).
  const opts = (buildPromptCalls[0] as { opts: { refPartLabels?: string[] } }).opts;
  assert.deepEqual(opts.refPartLabels, ["torso", "head", "hand_L"]);

  // Record persists the resolved ref_parts order.
  const record = ((await res.json()) as Record<string, unknown>)["record"] as Record<string, unknown>;
  assert.deepEqual(record["ref_parts"], ["torso", "head", "hand_L"]);
});

test("POST /api/animate rejects more than 15 reference parts", async () => {
  reset();
  const many = Array.from({ length: 16 }, (_, i) => `p${i}`);
  const res = await post(app(), "/api/animate", { description: "x", rows: 2, cols: 2, ref_parts: many });
  assert.equal(res.status, 400);
  assert.equal(editCalls.length, 0);
});

test("POST /api/animate persists the action name for sprite playback", async () => {
  reset();
  const res = await post(app(), "/api/animate", { description: "a knight", rows: 2, cols: 2, name: "wave" });
  assert.equal(res.status, 200);
  const record = ((await res.json()) as Record<string, unknown>)["record"] as Record<string, unknown>;
  assert.equal(record["name"], "wave");
});

test("PATCH /api/animations/:id reassigns the action name", async () => {
  reset();
  // Create a record, then rename its action.
  const created = (await (await post(app(), "/api/animate", {
    description: "a mage",
    rows: 2,
    cols: 2,
    name: "idle",
  })).json()) as Record<string, unknown>;
  const id = (created["record"] as Record<string, unknown>)["id"] as string;

  const res = await app().request(`/api/animations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "nod" }),
  });
  assert.equal(res.status, 200);
  const record = ((await res.json()) as Record<string, unknown>)["record"] as Record<string, unknown>;
  assert.equal(record["name"], "nod");

  // Persisted: a fresh GET reflects the new name.
  const list = (await (await app().request("/api/animations")).json()) as {
    records: Array<Record<string, unknown>>;
  };
  assert.equal(list.records.find((r) => r["id"] === id)?.["name"], "nod");
});

test("PATCH /api/animations/:id 404s for an unknown id", async () => {
  const res = await app().request("/api/animations/does-not-exist", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "wave" }),
  });
  assert.equal(res.status, 404);
});
