// Prompt / profile / parts routes.
//
//   GET  /api/prompts   default profile → buildPrompts()
//   POST /api/prompts   character/preset/model override → buildPrompts(override)
//   GET  /api/profile   raw character_profile.json
//   GET  /api/parts     part list + `generated` flag per parts/<id>.png
import type { Hono } from "hono";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { PARTS_DIR } from "../paths.ts";
import {
  buildPrompts,
  getAllParts,
  loadConfig,
  loadDefaultProfile,
  type ProfileOverride,
} from "../prompts.ts";

export function register(app: Hono): void {
  app.get("/api/prompts", (c) => c.json(buildPrompts()));

  app.post("/api/prompts", async (c) => {
    let b: unknown;
    try {
      b = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    // The builder only reads known override keys; anything else is ignored.
    return c.json(buildPrompts((b ?? {}) as ProfileOverride));
  });

  app.get("/api/profile", (c) => c.json(loadDefaultProfile()));

  app.get("/api/parts", (c) => {
    const config = loadConfig();
    if (!existsSync(PARTS_DIR)) mkdirSync(PARTS_DIR, { recursive: true });
    const existing = new Set(
      readdirSync(PARTS_DIR)
        .filter((f) => f.toLowerCase().endsWith(".png"))
        .map((f) => f.slice(0, -".png".length)),
    );
    const result = getAllParts(config).map((p) => ({
      id: p.id,
      label_cn: p.label_cn,
      generated: existing.has(p.id),
    }));
    return c.json(result);
  });
}
