// Codex desktop-pet ("桌宠") atlas routes — the link-up layer for the pet track.
//
// Turns a pet description into a fixed 8×9 sprite atlas through a staged
// pipeline, mirroring the structure/style of routes/animation.ts:
//
//   POST /api/pet/prepare        plan a run: slug + base/row prompts (9 rows)
//   POST /api/pet/generate-base  render the approved base reference sprite
//   POST /api/pet/generate-row   render one state's strip -> slice -> inspect
//   POST /api/pet/compose        gather 9 rows -> atlas.png + spritesheet.webp
//   GET  /api/pet/runs           list persisted run records
//   GET  /api/pet/runs/:id       one run record
//
// Each run owns a directory pets/<petId>_<stamp>/ (git-ignored) holding base.png,
// per-state strips + sliced frames, atlas.png and spritesheet.webp. Those files
// are served read-only (and auth-gated) at GET /pets/* by the static handler.
// All of these endpoints live under /api/* so the existing bearer/cookie guard
// (registerAuth) already covers them; we add no unauthenticated top-level route.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { editImage, generateImage } from "../image-gen.ts";
import { PETS_DIR, partsPath, petsPath } from "../paths.ts";
import { ROW_SPECS, usedColsFor } from "../pet/contract.ts";
import { buildBasePrompt, buildRowPrompt } from "../pet/prompts.ts";
import type { PetState } from "../pet/prompts.ts";
import { composeAtlas, toWebp } from "../pet/compose-atlas.ts";
import { validateAtlas } from "../pet/validate-atlas.ts";
import { inspectFrames } from "../pet/inspect-frames.ts";
import { sliceStrip } from "../pet/slice-strip.ts";
import { mirrorFrames } from "../pet/mirror.ts";

// Max reference images a prepare/generate request may attach. gpt-image's edit
// endpoint accepts up to 16 inputs; we keep the cap conservative since a pet
// only needs a handful of identity references.
const MAX_REF_PARTS = 8;

/** The 9 fixed pet states, kept as a Set for O(1) request validation. */
const VALID_STATES = new Set<string>(ROW_SPECS.map((s) => s.state));

/** Per-row job plan entry persisted in a run record (loosely typed, extensible). */
type RowJob = Record<string, unknown> & {
  state: string;
  row: number;
  usedCols: number;
  prompt: string;
  status: string;
};

/** A persisted pet-run record (loosely typed — extra keys are preserved). */
type PetRecord = Record<string, unknown> & { id?: string; timestamp?: string };

/** Lightweight project manager persisting time-ordered pet runs to history.json. */
class PetStore {
  readonly historyPath: string;
  records: PetRecord[];

  constructor() {
    this.historyPath = petsPath("history.json");
    this.records = this.load();
  }

  private load(): PetRecord[] {
    if (!existsSync(this.historyPath)) return [];
    try {
      const data: unknown = JSON.parse(readFileSync(this.historyPath, "utf-8"));
      return Array.isArray(data) ? (data as PetRecord[]) : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    mkdirSync(PETS_DIR, { recursive: true });
    writeFileSync(this.historyPath, JSON.stringify(this.records, null, 2) + "\n", "utf-8");
  }

  /** Append a record (assigning id + timestamp + status if absent); return its id. */
  add(record: PetRecord): string {
    const stored: PetRecord = structuredClone(record);
    const id = (typeof stored.id === "string" && stored.id) || randomUUID().replace(/-/g, "").slice(0, 12);
    stored.id = id;
    if (!stored.timestamp) stored.timestamp = new Date().toISOString();
    if (!stored["status"]) stored["status"] = "prepared";
    this.records.push(stored);
    this.save();
    return id;
  }

  get(id: string): PetRecord | null {
    return this.records.find((r) => r.id === id) ?? null;
  }

  /** Shallow-merge `patch` into the record with `id`; returns it, or null if absent. */
  update(id: string, patch: PetRecord): PetRecord | null {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return null;
    Object.assign(rec, patch);
    this.save();
    return rec;
  }
}

/** Optional trimmed string from a request body ("None"/empty -> undefined). */
function optStr(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v && v !== "None" ? v : undefined;
}

/**
 * Derive a filesystem-safe slug from a name. Lowercased, non-alphanumerics
 * collapsed to single dashes, trimmed. Falls back to "pet" so a run directory
 * always has a stable, path-safe prefix even for empty/emoji-only names.
 */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "pet";
}

/**
 * Compose the free-text "pet identity" notes fed to the prompt builders from the
 * display name + description. Both are optional; we join what we have so the
 * prompt still reads naturally when only one is supplied.
 */
function buildPetNotes(displayName: string, description?: string): string {
  const parts: string[] = [];
  if (displayName) parts.push(displayName);
  if (description) parts.push(description);
  return parts.join(" — ").trim();
}

/**
 * Resolve an ordered list of part ids into existing parts/<id>.png paths,
 * preserving order and dropping ids without a generated PNG. Used as optional
 * identity references for base-sprite generation (mirrors animation.ts's
 * resolveRefParts, minus the label lookup the pet track doesn't need).
 */
function resolveRefParts(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    const path = partsPath(`${id}.png`);
    if (!existsSync(path)) continue;
    seen.add(id);
    resolved.push(path);
  }
  return resolved;
}

/**
 * Turn an absolute path inside PETS_DIR into a browser-facing /pets/... URL.
 * Returns null for paths outside the tree so we never leak an arbitrary path as
 * a served URL.
 */
function petUrl(absPath: unknown): string | null {
  if (typeof absPath !== "string" || !absPath) return null;
  const rel = relative(PETS_DIR, absPath);
  if (!rel || rel.startsWith("..")) return null;
  // Normalise Windows-style separators to URL slashes.
  return `/pets/${rel.split(/[\\/]+/).join("/")}`;
}

/**
 * Return a copy of `record` enriched with browser-facing `*_url` fields derived
 * from its stored absolute paths (mirrors animation.ts's recordUrls). Row job
 * frame/strip paths are surfaced as URL arrays so the client can render each
 * state without knowing the on-disk layout.
 */
function recordUrls(record: PetRecord): PetRecord {
  const enriched: PetRecord = structuredClone(record);
  enriched["base_url"] = petUrl(record["basePath"]);
  enriched["atlas_url"] = petUrl(record["atlasPath"]);
  enriched["webp_url"] = petUrl(record["webpPath"]);
  if (Array.isArray(enriched["rows"])) {
    enriched["rows"] = (enriched["rows"] as RowJob[]).map((job) => {
      const framePaths = Array.isArray(job["framePaths"]) ? (job["framePaths"] as unknown[]) : [];
      return {
        ...job,
        strip_url: petUrl(job["stripPath"]),
        frame_urls: framePaths.map((p) => petUrl(p)).filter((u): u is string => u !== null),
      };
    });
  }
  return enriched;
}

/** Find a row job by state within a run record's `rows` array. */
function findRowJob(record: PetRecord, state: string): RowJob | null {
  const rows = Array.isArray(record["rows"]) ? (record["rows"] as RowJob[]) : [];
  return rows.find((j) => j.state === state) ?? null;
}

export function register(app: Hono): void {
  // Plan a run: derive identity, build base + 9 row prompts, create the run
  // directory, and persist a "prepared" record with a pending job per row.
  app.post("/api/pet/prepare", async (c) => {
    let b: Record<string, unknown>;
    try {
      b = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const petName = optStr(b["petName"]);
    const description = optStr(b["description"]);
    const styleNotes = optStr(b["styleNotes"]);

    // Reject an oversized reference list up front (mirrors animation.ts).
    if (Array.isArray(b["refParts"]) && b["refParts"].length > MAX_REF_PARTS) {
      return c.json({ error: `最多选择 ${MAX_REF_PARTS} 个参考部件 (max ${MAX_REF_PARTS} reference parts).` }, 400);
    }
    if (!petName && !description) {
      return c.json({ error: "Provide 'petName' or 'description'." }, 400);
    }

    const displayName = petName ?? "";
    const petId = slugify(petName || description || "pet");
    const petNotes = buildPetNotes(displayName, description);
    const refParts = resolveRefParts(b["refParts"]);

    const basePrompt = buildBasePrompt({ petNotes, styleNotes });
    // One job per atlas row, in ROW_SPECS order (row 0..8). usedCols/prompt are
    // load-bearing downstream (slicer + inspector read them), so freeze them now.
    const rows: RowJob[] = ROW_SPECS.map(({ state, row, usedCols }) => ({
      state,
      row,
      usedCols,
      prompt: buildRowPrompt({ petId, state: state as PetState, petNotes, styleNotes }),
      status: "pending",
    }));

    const stamp = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}_${randomUUID().replace(/-/g, "").slice(0, 6)}`;
    const runDir = petsPath(`${petId}_${stamp}`);
    mkdirSync(join(runDir, "rows"), { recursive: true });

    const store = new PetStore();
    const id = store.add({
      status: "prepared",
      petId,
      displayName,
      description: description ?? null,
      styleNotes: styleNotes ?? null,
      petNotes,
      basePrompt,
      refParts,
      runDir,
      rows,
    });

    const record = recordUrls(store.get(id) ?? {});
    return c.json({ runId: id, petId, rows: record["rows"], record });
  });

  // Render the approved base reference sprite (single centred pose, transparent
  // bg). With refImages we edit against them so the pet matches supplied art;
  // otherwise we generate from the base prompt alone. Stored as <runDir>/base.png
  // and reused as the identity reference for every row.
  app.post("/api/pet/generate-base", async (c) => {
    let b: Record<string, unknown>;
    try {
      b = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const runId = optStr(b["runId"]);
    if (!runId) return c.json({ error: "Provide 'runId'." }, 400);

    const store = new PetStore();
    const record = store.get(runId);
    if (!record) return c.json({ error: `No pet run with id ${runId}` }, 404);

    const runDir = typeof record["runDir"] === "string" ? record["runDir"] : petsPath(String(record["petId"] ?? "pet"));
    const basePrompt = typeof record["basePrompt"] === "string" ? record["basePrompt"] : "";

    // Prefer explicit refImages from the request, else fall back to the parts
    // resolved at prepare time. Either can drive an edit; empty => text-to-image.
    const reqRefs = resolveRefParts(b["refImages"]);
    const storedRefs = Array.isArray(record["refParts"]) ? (record["refParts"] as unknown[]).filter((p): p is string => typeof p === "string") : [];
    const refs = reqRefs.length > 0 ? reqRefs : storedRefs;

    let bytes: Uint8Array;
    try {
      bytes = refs.length > 0
        ? await editImage({ prompt: basePrompt, images: refs, background: "transparent" })
        : await generateImage({ prompt: basePrompt, background: "transparent" });
    } catch (e) {
      store.update(runId, { status: "base-failed", baseError: (e as Error).message });
      return c.json({ error: `Base generation failed: ${(e as Error).message}` }, 502);
    }

    mkdirSync(runDir, { recursive: true });
    const basePath = join(runDir, "base.png");
    writeFileSync(basePath, bytes);
    store.update(runId, { status: "base-ready", basePath });

    const updated = recordUrls(store.get(runId) ?? {});
    return c.json({ base_url: updated["base_url"], record: updated });
  });

  // Render one state's horizontal strip, slice it into usedCols transparent
  // frames, and inspect the row. running-left can instead be mirrored from an
  // already-generated running-right row (mirrorFrom), skipping a second render.
  app.post("/api/pet/generate-row", async (c) => {
    let b: Record<string, unknown>;
    try {
      b = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const runId = optStr(b["runId"]);
    if (!runId) return c.json({ error: "Provide 'runId'." }, 400);
    const state = optStr(b["state"]);
    if (!state || !VALID_STATES.has(state)) {
      return c.json({ error: `Invalid state; expected one of ${ROW_SPECS.map((s) => s.state).join(", ")}` }, 400);
    }

    const store = new PetStore();
    const record = store.get(runId);
    if (!record) return c.json({ error: `No pet run with id ${runId}` }, 404);

    const runDir = typeof record["runDir"] === "string" ? record["runDir"] : petsPath(String(record["petId"] ?? "pet"));
    const job = findRowJob(record, state);
    if (!job) return c.json({ error: `Run ${runId} has no planned row for state ${state}` }, 400);

    const expected = usedColsFor(state);
    const stateDir = join(runDir, "rows", state);
    mkdirSync(stateDir, { recursive: true });

    let frames: Buffer[];
    let stripPath: string | null = null;
    let derivedFrom: string | null = null;

    // Mirror path: only for a state that is a horizontal reflection of another
    // whose frames already exist on disk (running-left <- running-right).
    const mirrorFrom = optStr(b["mirrorFrom"]);
    const sourceJob = mirrorFrom ? findRowJob(record, mirrorFrom) : null;
    const sourceFramePaths = sourceJob && Array.isArray(sourceJob["framePaths"])
      ? (sourceJob["framePaths"] as unknown[]).filter((p): p is string => typeof p === "string")
      : [];
    const canMirror = mirrorFrom && sourceFramePaths.length === expected && sourceFramePaths.every((p) => existsSync(p));

    if (canMirror) {
      const sourceFrames = sourceFramePaths.map((p) => readFileSync(p));
      frames = await mirrorFrames(sourceFrames);
      derivedFrom = mirrorFrom!;
    } else {
      // Generate the strip by editing against the approved base reference so the
      // pet identity carries across rows; transparent bg for clean slicing.
      const basePath = typeof record["basePath"] === "string" ? record["basePath"] : "";
      if (!basePath || !existsSync(basePath)) {
        return c.json({ error: "Base sprite not generated yet; call /api/pet/generate-base first." }, 400);
      }
      const prompt = typeof job["prompt"] === "string" ? job["prompt"] : "";
      let stripBytes: Uint8Array;
      try {
        stripBytes = await editImage({ prompt, images: [basePath], background: "transparent" });
      } catch (e) {
        return c.json({ error: `Row generation failed for ${state}: ${(e as Error).message}` }, 502);
      }
      stripPath = join(runDir, "rows", `${state}-strip.png`);
      writeFileSync(stripPath, stripBytes);
      frames = await sliceStrip(Buffer.from(stripBytes), expected);
    }

    // Persist each sliced/mirrored frame as rows/<state>/<i>.png.
    const framePaths: string[] = [];
    for (let i = 0; i < frames.length; i++) {
      const framePath = join(stateDir, `${i}.png`);
      writeFileSync(framePath, frames[i]!);
      framePaths.push(framePath);
    }

    // Deterministic pre-atlas quality check for this row.
    const inspection = await inspectFrames(frames, state);

    // Merge the row job in place, preserving the plan's other rows.
    const rows = (Array.isArray(record["rows"]) ? (record["rows"] as RowJob[]) : []).map((j) =>
      j.state === state
        ? { ...j, status: inspection.ok ? "generated" : "generated-with-warnings", stripPath, framePaths, derivedFrom, inspection }
        : j,
    );
    store.update(runId, { rows });

    const updated = recordUrls(store.get(runId) ?? {});
    const updatedJob = (updated["rows"] as RowJob[]).find((j) => j.state === state) ?? {};
    return c.json({
      state,
      derivedFrom,
      inspection,
      frame_urls: (updatedJob as Record<string, unknown>)["frame_urls"] ?? [],
      strip_url: (updatedJob as Record<string, unknown>)["strip_url"] ?? null,
    });
  });

  // Gather all 9 rows' frames, compose the fixed atlas, encode a lossless WebP,
  // and validate against the contract. A missing/short row fails with 400 naming
  // what's absent rather than composing gaps that validateAtlas would reject.
  app.post("/api/pet/compose", async (c) => {
    let b: Record<string, unknown>;
    try {
      b = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const runId = optStr(b["runId"]);
    if (!runId) return c.json({ error: "Provide 'runId'." }, 400);

    const store = new PetStore();
    const record = store.get(runId);
    if (!record) return c.json({ error: `No pet run with id ${runId}` }, 404);

    const runDir = typeof record["runDir"] === "string" ? record["runDir"] : petsPath(String(record["petId"] ?? "pet"));

    // Assemble state -> frame buffers, checking each row is present and complete.
    const rowsMap = new Map<string, Buffer[]>();
    const missing: string[] = [];
    for (const { state, usedCols } of ROW_SPECS) {
      const job = findRowJob(record, state);
      const framePaths = job && Array.isArray(job["framePaths"])
        ? (job["framePaths"] as unknown[]).filter((p): p is string => typeof p === "string")
        : [];
      if (framePaths.length < usedCols || !framePaths.every((p) => existsSync(p))) {
        missing.push(`${state} (have ${framePaths.filter((p) => existsSync(p)).length}/${usedCols})`);
        continue;
      }
      rowsMap.set(state, framePaths.map((p) => readFileSync(p)));
    }
    if (missing.length > 0) {
      return c.json({ error: `Missing or incomplete rows: ${missing.join(", ")}` }, 400);
    }

    let atlas: Buffer;
    try {
      atlas = await composeAtlas(rowsMap);
    } catch (e) {
      return c.json({ error: `Compose failed: ${(e as Error).message}` }, 500);
    }
    mkdirSync(runDir, { recursive: true });
    const atlasPath = join(runDir, "atlas.png");
    writeFileSync(atlasPath, atlas);

    const webp = await toWebp(atlas);
    const webpPath = join(runDir, "spritesheet.webp");
    writeFileSync(webpPath, webp);

    const validation = await validateAtlas(atlas);
    store.update(runId, {
      status: validation.ok ? "composed" : "composed-invalid",
      atlasPath,
      webpPath,
      validation,
    });

    const updated = recordUrls(store.get(runId) ?? {});
    return c.json({
      validation,
      atlas_url: updated["atlas_url"],
      webp_url: updated["webp_url"],
      record: updated,
    });
  });

  // List all persisted pet runs (paths surfaced as /pets/ URLs).
  app.get("/api/pet/runs", (c) => {
    const store = new PetStore();
    return c.json({ records: store.records.map(recordUrls) });
  });

  // One run record by id.
  app.get("/api/pet/runs/:id", (c) => {
    const store = new PetStore();
    const record = store.get(c.req.param("id"));
    if (!record) return c.json({ error: `No pet run with id ${c.req.param("id")}` }, 404);
    return c.json({ record: recordUrls(record) });
  });
}
