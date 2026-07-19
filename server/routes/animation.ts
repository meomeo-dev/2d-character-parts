// Sprite-sheet animation routes.
//
//   POST /api/animate     STUB (animation track — server/image/animation.ts)
//   GET  /api/animations  STUB (animation track — list persisted records)
//
// Generated grids/sheets/GIFs land in animations/ and are served by the static
// handler at GET /animations/*.
import type { Hono } from "hono";

export function register(app: Hono): void {
  // TODO(animation track): idea -> grid -> img2img sheet -> GIF; persist under animations/.
  app.post("/api/animate", (c) => c.json({ error: "not implemented", todo: "animation track" }, 501));

  // TODO(animation track): return persisted animation records with /animations/ URLs.
  app.get("/api/animations", (c) => c.json({ error: "not implemented", todo: "animation track" }, 501));
}
