// Sprite-sheet animation routes — port of animation_routes.py (Track B).
//
//   POST /api/animate     idea/description -> grid -> img2img sheet -> GIF
//   GET  /api/animations  list persisted animation records
//
// Generated grids/sheets/GIFs land in animations/ (git-ignored) and are served
// by the static handler at GET /animations/*.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { chat } from "../llm.ts";
import { buildPrompt, createGrid, sliceAndGif } from "../image/animation.ts";
import { editImage } from "../image-gen.ts";
import { ANIMATIONS_DIR, animationsPath } from "../paths.ts";

// Pixels per grid cell for the reference template. The final sheet is
// re-measured at slice time, so this only sets the reference aspect.
const CELL_PX = 256;

// Idea -> English action description. Keeps technical sprite-sheet terms out of
// the description itself (the template/prompt supply the grid structure).
const IDEA_SYSTEM_PROMPT =
  "You are an expert at writing detailed visual descriptions for 2D sprite sheet animations. " +
  "The user provides a simple concept; expand it into a concise but descriptive sentence focusing " +
  "on the subject's appearance, clothing, equipment, and the specific action. Do not include " +
  "technical terms like 'sprite sheet', 'grid', 'frame', 'sequence', or 'animation' in the " +
  "description. Always output the description in English, regardless of the user's input language.";

/** A persisted animation record (loosely typed — extra keys are preserved). */
type AnimationRecord = Record<string, unknown> & { id?: string; timestamp?: string };

/** Lightweight project manager persisting time-ordered records to history.json. */
class AnimationStore {
  readonly historyPath: string;
  records: AnimationRecord[];

  constructor(root: string) {
    this.historyPath = animationsPathIn(root, "history.json");
    this.records = this.load();
  }

  private load(): AnimationRecord[] {
    if (!existsSync(this.historyPath)) return [];
    try {
      const data: unknown = JSON.parse(readFileSync(this.historyPath, "utf-8"));
      return Array.isArray(data) ? (data as AnimationRecord[]) : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    mkdirSync(ANIMATIONS_DIR, { recursive: true });
    writeFileSync(this.historyPath, JSON.stringify(this.records, null, 2) + "\n", "utf-8");
  }

  /** Append a record (assigning id + timestamp + status if absent); return its id. */
  add(record: AnimationRecord): string {
    const stored: AnimationRecord = structuredClone(record);
    const id = (typeof stored.id === "string" && stored.id) || randomUUID().replace(/-/g, "").slice(0, 12);
    stored.id = id;
    if (!stored.timestamp) stored.timestamp = new Date().toISOString();
    if (!stored["status"]) stored["status"] = "completed";
    this.records.push(stored);
    this.save();
    return id;
  }

  get(id: string): AnimationRecord | null {
    return this.records.find((r) => r.id === id) ?? null;
  }

  getLast(): AnimationRecord | null {
    return this.records.length ? this.records[this.records.length - 1]! : null;
  }
}

/** Join `history.json` etc. under an arbitrary root (store may be rooted anywhere). */
function animationsPathIn(root: string, name: string): string {
  return `${root.replace(/\/+$/, "")}/${name}`;
}

/** Coerce a grid dimension into the valid 2–6 range. */
function clampDim(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(2, Math.min(6, Math.trunc(n)));
}

/**
 * Expand a short idea into an English action description via the LLM.
 *
 * Falls back to the raw idea if the call fails or returns nothing. Note: the
 * llm.chat stub is companion-chat shaped; the system prompt is threaded through
 * recentMessages, matching the plain system+user pair used by the Python port.
 */
async function expandIdea(idea: string): Promise<string> {
  try {
    const res = await chat({
      userMessage: idea,
      recentMessages: [{ role: "system", content: IDEA_SYSTEM_PROMPT }],
    });
    const text = typeof res.assistantMessage === "string" ? res.assistantMessage.trim() : "";
    return text || idea;
  } catch {
    return idea;
  }
}

/** Return a copy of `record` with browser-facing /animations/ URLs added. */
function recordUrls(record: AnimationRecord): AnimationRecord {
  const enriched: AnimationRecord = { ...record };
  const imagePath = record["image_path"];
  const gifPath = record["gif_path"];
  if (typeof imagePath === "string" && imagePath) enriched["sheet_url"] = `/animations/${basename(imagePath)}`;
  if (typeof gifPath === "string" && gifPath) enriched["gif_url"] = `/animations/${basename(gifPath)}`;
  return enriched;
}

/** Optional string modifier from the request body ("None"/empty -> undefined). */
function optStr(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v && v !== "None" ? v : undefined;
}

export function register(app: Hono): void {
  app.post("/api/animate", async (c) => {
    let b: Record<string, unknown>;
    try {
      b = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const idea = (typeof b["idea"] === "string" ? b["idea"] : "").trim();
    let description = (typeof b["description"] === "string" ? b["description"] : "").trim();
    let mode = typeof b["mode"] === "string" ? b["mode"] : "new";
    let rows = clampDim(b["rows"], 3);
    let cols = clampDim(b["cols"], 4);
    const style = optStr(b["style"]);
    const era = optStr(b["era"]);
    const lighting = optStr(b["lighting"]);
    const composition = optStr(b["composition"]);
    const color = optStr(b["color"]);

    if (!description) {
      if (!idea) return c.json({ error: "Provide 'idea' or 'description'." }, 400);
      description = await expandIdea(idea);
    }

    mkdirSync(ANIMATIONS_DIR, { recursive: true });
    const store = new AnimationStore(ANIMATIONS_DIR);

    // Continuation mode aligns the grid with the previous sequence. The
    // seed-row synthesis (sprite_animation.synthesize_continuation_grid) has no
    // TS stub yet, so continuation reuses the blank template as its reference —
    // matching the Python fallback path when synthesis is unavailable.
    let prevPromptContext: string | undefined;
    const prev = mode === "continue" ? store.getLast() : null;
    if (
      prev &&
      typeof prev["image_path"] === "string" &&
      existsSync(prev["image_path"] as string)
    ) {
      const gc = (prev["grid_config"] ?? {}) as Record<string, unknown>;
      rows = clampDim(gc["rows"], rows);
      cols = clampDim(gc["cols"], cols);
      prevPromptContext = typeof prev["description"] === "string" ? (prev["description"] as string) : undefined;
    } else {
      mode = "new";
    }

    const stamp = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}_${randomUUID().replace(/-/g, "").slice(0, 6)}`;
    const targetWidth = cols * CELL_PX + (cols + 1) * 2;

    // 1. Blank grid template (structural reference for img2img).
    let grid;
    try {
      grid = await createGrid(rows, cols, targetWidth);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    const templatePath = animationsPath(`grid_${rows}x${cols}_${stamp}.png`);
    writeFileSync(templatePath, grid.png);

    // 2. Build the prompt and run img2img generation from the template.
    const prompt = buildPrompt(description, rows, cols, {
      style,
      era,
      lighting,
      composition,
      color,
      mode,
      prevPromptContext,
    });

    let sheetBytes: Uint8Array;
    try {
      sheetBytes = await editImage({ prompt, images: [templatePath] });
    } catch (e) {
      return c.json({ error: `Image generation failed: ${(e as Error).message}` }, 502);
    }
    const sheetPath = animationsPath(`sheet_${rows}x${cols}_${stamp}.png`);
    writeFileSync(sheetPath, sheetBytes);

    // 3. Slice into frames and export the preview GIF.
    const gifPath = animationsPath(`anim_${rows}x${cols}_${stamp}.gif`);
    try {
      const gif = await sliceAndGif(Buffer.from(sheetBytes), rows, cols, { outPath: gifPath });
      writeFileSync(gifPath, gif);
    } catch (e) {
      return c.json({ error: `GIF export failed: ${(e as Error).message}` }, 500);
    }

    // 4. Persist the record and respond.
    const id = store.add({
      image_path: sheetPath,
      prompt,
      description,
      grid_config: { rows, cols },
      style: style ?? null,
      era: era ?? null,
      lighting: lighting ?? null,
      composition: composition ?? null,
      color: color ?? null,
      idea: idea || null,
      status: "completed",
      gif_path: gifPath,
      generation_mode: mode,
    });

    const record = recordUrls(store.get(id) ?? {});
    return c.json({
      gif_url: record["gif_url"] ?? null,
      sheet_url: record["sheet_url"] ?? null,
      record,
    });
  });

  app.get("/api/animations", (c) => {
    const store = new AnimationStore(ANIMATIONS_DIR);
    return c.json({ records: store.records.map(recordUrls) });
  });
}
