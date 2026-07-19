// Prompt / profile / parts routes.
//
//   GET  /api/prompts   STUB (prompts track — server/prompts.ts#buildPrompts)
//   POST /api/prompts   STUB (prompts track — accepts character/preset override)
//   GET  /api/profile   STUB (prompts track — character_profile.json)
//   GET  /api/parts     STUB (prompts track — part list + generated flags)
import type { Hono } from "hono";

export function register(app: Hono): void {
  // TODO(prompts track): return buildPrompts() for GET, buildPrompts(override) for POST.
  app.get("/api/prompts", (c) => c.json({ error: "not implemented", todo: "prompts track" }, 501));
  app.post("/api/prompts", (c) => c.json({ error: "not implemented", todo: "prompts track" }, 501));

  // TODO(prompts track): return config/character_profile.json.
  app.get("/api/profile", (c) => c.json({ error: "not implemented", todo: "prompts track" }, 501));

  // TODO(prompts track): list parts with a `generated` flag per existing parts/<id>.png.
  app.get("/api/parts", (c) => c.json({ error: "not implemented", todo: "prompts track" }, 501));
}
