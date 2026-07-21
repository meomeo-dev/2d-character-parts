// Route tests for the Codex pet atlas track (/api/pet/*).
//
// Only the network-facing image-gen module and the filesystem paths are mocked;
// the deterministic pet pipeline (contract/slice/inspect/compose/validate/mirror)
// runs for real against synthesized transparent PNGs. The mocked editImage /
// generateImage read the requested frame count out of the prompt and return a
// real N-slot transparent strip (base prompt => a single centred sprite), so the
// slicer, inspector, composer and validator all exercise genuine pixels.
// Run: node --import tsx --experimental-test-module-mocks --test server/routes/pet.test.ts
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import sharp from "sharp";

const SERVER_DIR = join(import.meta.dirname, "..");
const url = (rel: string) => pathToFileURL(join(SERVER_DIR, rel)).href;

const CELL_W = 192;
const CELL_H = 208;

// Tmp workspace standing in for the worktree root.
const TMP = mkdtempSync(join(tmpdir(), "pet-routes-"));
const PETS_DIR = join(TMP, "pets");
const PARTS_DIR = join(TMP, "parts");

let register: (app: Hono) => void;

/**
 * Build a real horizontal transparent strip with `frames` centred opaque blocks.
 * This stands in for a gpt-image row render: N evenly-spaced poses on alpha=0,
 * exactly what sliceStrip expects. Block size is comfortably inside a cell so the
 * sliced/centred frames clear inspectFrames' minimum-pixel and edge checks.
 */
async function buildStrip(frames: number): Promise<Uint8Array> {
  const slotW = CELL_W;
  const block = await sharp({
    create: { width: 90, height: 120, channels: 4, background: { r: 180, g: 90, b: 40, alpha: 255 } },
  })
    .png()
    .toBuffer();
  const composites = Array.from({ length: frames }, (_, i) => ({
    input: block,
    left: i * slotW + Math.floor((slotW - 90) / 2),
    top: Math.floor((CELL_H - 120) / 2),
  }));
  const png = await sharp({
    create: { width: frames * slotW, height: CELL_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .png()
    .toBuffer();
  return new Uint8Array(png);
}

/**
 * Infer the frame count from a row prompt. buildRowPrompt embeds
 * "Output exactly N full-body frames", so we read N back to size the fake strip.
 * A base prompt has no such phrase => single centred sprite (1 frame).
 */
function frameCountFromPrompt(prompt: string): number {
  const m = /Output exactly (\d+) full-body frames/.exec(prompt);
  return m ? Number(m[1]) : 1;
}

before(async () => {
  mock_paths();
  await mock_imagegen();
  mock_llm();
  ({ register } = await import(url("./routes/pet.ts")));
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function mock_paths(): void {
  mock.module(url("paths.ts"), {
    namedExports: {
      ROOT: TMP,
      CONFIG_DIR: join(TMP, "config"),
      TEMPLATES_DIR: join(TMP, "templates"),
      PARTS_DIR,
      ANIMATIONS_DIR: join(TMP, "animations"),
      PETS_DIR,
      configPath: (...s: string[]) => join(TMP, "config", ...s),
      templatesPath: (...s: string[]) => join(TMP, "templates", ...s),
      partsPath: (...s: string[]) => join(PARTS_DIR, ...s),
      animationsPath: (...s: string[]) => join(TMP, "animations", ...s),
      petsPath: (...s: string[]) => join(PETS_DIR, ...s),
    },
  });
}

async function mock_imagegen(): Promise<void> {
  mock.module(url("image-gen.ts"), {
    namedExports: {
      toOpenAISize: () => "auto",
      // Base render: one centred sprite. Row render: an N-slot strip sized from
      // the prompt so the real slicer produces exactly usedCols frames.
      generateImage: async (opts: { prompt: string }) => buildStrip(frameCountFromPrompt(opts.prompt)),
      editImage: async (opts: { prompt: string }) => buildStrip(frameCountFromPrompt(opts.prompt)),
    },
  });
}

// Stub the multimodal visualQa so /api/pet/qa never touches a real provider or
// network. Returns a deterministic "pass" verdict; the graceful-degradation
// paths are covered by llm.test.ts against the real visualQa.
function mock_llm(): void {
  mock.module(url("llm.ts"), {
    namedExports: {
      visualQa: async () => ({ visual_qa: "pass", notes: "looks consistent", repair_rows: [] }),
    },
  });
}

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

/** Prepare a run and return its runId. */
async function prepareRun(a: Hono): Promise<string> {
  const res = await post(a, "/api/pet/prepare", { petName: "Tofu", description: "a small round orange cat" });
  const json = (await res.json()) as Record<string, unknown>;
  return json["runId"] as string;
}

// The 9 atlas states and their frame counts, mirrored from the contract.
const STATE_COLS: Record<string, number> = {
  idle: 6,
  "running-right": 8,
  "running-left": 8,
  waving: 4,
  jumping: 5,
  failed: 8,
  waiting: 6,
  running: 6,
  review: 6,
};

test("POST /api/pet/prepare returns 9 row jobs and a valid runId", async () => {
  const a = app();
  const res = await post(a, "/api/pet/prepare", {
    petName: "Tofu",
    description: "a small round orange cat",
    styleNotes: "flat cel shading",
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Record<string, unknown>;

  assert.ok(typeof json["runId"] === "string" && (json["runId"] as string).length > 0);
  assert.equal(json["petId"], "tofu");
  const rows = json["rows"] as Array<Record<string, unknown>>;
  assert.equal(rows.length, 9);
  // Row order + counts match the contract and every job starts pending.
  for (const [i, state] of Object.keys(STATE_COLS).entries()) {
    assert.equal(rows[i]!["state"], state);
    assert.equal(rows[i]!["usedCols"], STATE_COLS[state]);
    assert.equal(rows[i]!["status"], "pending");
    assert.ok(String(rows[i]!["prompt"]).length > 0);
  }
});

test("POST /api/pet/prepare rejects when neither petName nor description given", async () => {
  const res = await post(app(), "/api/pet/prepare", {});
  assert.equal(res.status, 400);
});

test("POST /api/pet/generate-base renders base.png and marks the run base-ready", async () => {
  const a = app();
  const runId = await prepareRun(a);
  const res = await post(a, "/api/pet/generate-base", { runId });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Record<string, unknown>;
  assert.match(String(json["base_url"]), /^\/pets\/.*\/base\.png$/);
  const record = json["record"] as Record<string, unknown>;
  assert.equal(record["status"], "base-ready");
});

test("POST /api/pet/generate-row slices a strip into usedCols frames and inspects them", async () => {
  const a = app();
  const runId = await prepareRun(a);
  await post(a, "/api/pet/generate-base", { runId });

  const res = await post(a, "/api/pet/generate-row", { runId, state: "waving" });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Record<string, unknown>;
  assert.equal(json["state"], "waving");
  const inspection = json["inspection"] as Record<string, unknown>;
  assert.equal(inspection["state"], "waving");
  assert.equal(inspection["ok"], true, `inspect errors: ${JSON.stringify(inspection["errors"])}`);
  // waving uses 4 columns -> 4 sliced frames surfaced as URLs.
  const frameUrls = json["frame_urls"] as string[];
  assert.equal(frameUrls.length, STATE_COLS["waving"]);
  for (const u of frameUrls) assert.match(u, /^\/pets\/.*\/rows\/waving\/\d+\.png$/);
});

test("POST /api/pet/generate-row can mirror running-left from running-right", async () => {
  const a = app();
  const runId = await prepareRun(a);
  await post(a, "/api/pet/generate-base", { runId });

  await post(a, "/api/pet/generate-row", { runId, state: "running-right" });
  const res = await post(a, "/api/pet/generate-row", {
    runId,
    state: "running-left",
    mirrorFrom: "running-right",
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Record<string, unknown>;
  assert.equal(json["derivedFrom"], "running-right");
  assert.equal((json["frame_urls"] as string[]).length, STATE_COLS["running-left"]);
});

test("POST /api/pet/generate-row rejects an invalid state", async () => {
  const a = app();
  const runId = await prepareRun(a);
  const res = await post(a, "/api/pet/generate-row", { runId, state: "moonwalk" });
  assert.equal(res.status, 400);
});

test("POST /api/pet/generate-row rejects a missing runId", async () => {
  const res = await post(app(), "/api/pet/generate-row", { state: "idle" });
  assert.equal(res.status, 400);
});

test("POST /api/pet/compose gathers 9 rows into a valid atlas + webp", async () => {
  const a = app();
  const runId = await prepareRun(a);
  await post(a, "/api/pet/generate-base", { runId });

  // Generate every row (mirror running-left from running-right for realism).
  for (const state of Object.keys(STATE_COLS)) {
    if (state === "running-left") {
      await post(a, "/api/pet/generate-row", { runId, state, mirrorFrom: "running-right" });
    } else {
      await post(a, "/api/pet/generate-row", { runId, state });
    }
  }

  const res = await post(a, "/api/pet/compose", { runId });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Record<string, unknown>;
  const validation = json["validation"] as Record<string, unknown>;
  assert.equal(validation["ok"], true, `validation errors: ${JSON.stringify(validation["errors"])}`);
  assert.match(String(json["atlas_url"]), /^\/pets\/.*\/atlas\.png$/);
  assert.match(String(json["webp_url"]), /^\/pets\/.*\/spritesheet\.webp$/);
  // Both artifacts landed on disk.
  const atlasRel = String(json["atlas_url"]).replace("/pets/", "");
  const webpRel = String(json["webp_url"]).replace("/pets/", "");
  assert.ok(existsSync(join(PETS_DIR, atlasRel)));
  assert.ok(existsSync(join(PETS_DIR, webpRel)));
});

test("POST /api/pet/compose 400s when rows are missing", async () => {
  const a = app();
  const runId = await prepareRun(a);
  await post(a, "/api/pet/generate-base", { runId });
  // Only one row generated -> compose must report the rest missing.
  await post(a, "/api/pet/generate-row", { runId, state: "idle" });
  const res = await post(a, "/api/pet/compose", { runId });
  assert.equal(res.status, 400);
  const json = (await res.json()) as Record<string, unknown>;
  assert.match(String(json["error"]), /Missing or incomplete rows/);
});

/** Drive a run all the way through /compose and return its runId. */
async function composeRun(a: Hono): Promise<string> {
  const runId = await prepareRun(a);
  await post(a, "/api/pet/generate-base", { runId });
  for (const state of Object.keys(STATE_COLS)) {
    if (state === "running-left") {
      await post(a, "/api/pet/generate-row", { runId, state, mirrorFrom: "running-right" });
    } else {
      await post(a, "/api/pet/generate-row", { runId, state });
    }
  }
  const res = await post(a, "/api/pet/compose", { runId });
  assert.equal(res.status, 200, "compose should succeed before qa/package");
  return runId;
}

test("POST /api/pet/qa validates the atlas and writes a contact sheet", async () => {
  const a = app();
  const runId = await composeRun(a);

  const res = await post(a, "/api/pet/qa", { runId });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Record<string, unknown>;
  const validation = json["validation"] as Record<string, unknown>;
  assert.equal(validation["ok"], true, `validation errors: ${JSON.stringify(validation["errors"])}`);
  assert.match(String(json["contact_sheet_url"]), /^\/pets\/.*\/qa\/contact-sheet\.png$/);
  // The contact sheet landed on disk.
  const rel = String(json["contact_sheet_url"]).replace("/pets/", "");
  assert.ok(existsSync(join(PETS_DIR, rel)));
  // The additive multimodal verdict is surfaced (mocked to "pass").
  const visual = json["visual_qa"] as Record<string, unknown>;
  assert.equal(visual["visual_qa"], "pass");
  assert.ok(Array.isArray(visual["repair_rows"]));
});

test("POST /api/pet/qa 400s when the run has no atlas", async () => {
  const a = app();
  const runId = await prepareRun(a);
  const res = await post(a, "/api/pet/qa", { runId });
  assert.equal(res.status, 400);
  const json = (await res.json()) as Record<string, unknown>;
  assert.match(String(json["error"]), /compose first/);
});

test("POST /api/pet/package writes pet.json + spritesheet for a validated run", async () => {
  const a = app();
  const runId = await composeRun(a);

  const res = await post(a, "/api/pet/package", { runId });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Record<string, unknown>;

  const manifestPath = String(json["manifest_path"]);
  const spritesheetPath = String(json["spritesheet_path"]);
  assert.ok(existsSync(manifestPath));
  assert.ok(existsSync(spritesheetPath));
  // Default outDir is inside the run dir (under pets/), not a cross-tree write.
  assert.equal(json["outside_pets_dir"], false);

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  assert.equal(manifest["id"], "tofu");
  assert.equal(manifest["displayName"], "Tofu");
  assert.equal(manifest["spritesheetPath"], "spritesheet.webp");
});

test("POST /api/pet/package 400s for an unvalidated run without force", async () => {
  const a = app();
  const runId = await composeRun(a);

  // Overwrite the stored validation to a failing state so the gate trips.
  const historyPath = join(PETS_DIR, "history.json");
  const history = JSON.parse(readFileSync(historyPath, "utf-8")) as Array<Record<string, unknown>>;
  const rec = history.find((r) => r["id"] === runId)!;
  rec["validation"] = { ok: false, errors: ["forced-invalid"], warnings: [] };
  writeFileSync(historyPath, JSON.stringify(history, null, 2) + "\n", "utf-8");

  const blocked = await post(a, "/api/pet/package", { runId });
  assert.equal(blocked.status, 400);
  const json = (await blocked.json()) as Record<string, unknown>;
  assert.match(String(json["error"]), /has not passed validation/);

  // force:true bypasses the gate.
  const forced = await post(a, "/api/pet/package", { runId, force: true });
  assert.equal(forced.status, 200);
});

test("GET /api/pet/runs and /api/pet/runs/:id return persisted records", async () => {
  const a = app();
  const runId = await prepareRun(a);

  const list = (await (await a.request("/api/pet/runs")).json()) as { records: Array<Record<string, unknown>> };
  assert.ok(list.records.some((r) => r["id"] === runId));

  const single = await a.request(`/api/pet/runs/${runId}`);
  assert.equal(single.status, 200);
  const record = ((await single.json()) as Record<string, unknown>)["record"] as Record<string, unknown>;
  assert.equal(record["id"], runId);

  const missing = await a.request("/api/pet/runs/does-not-exist");
  assert.equal(missing.status, 404);
});
