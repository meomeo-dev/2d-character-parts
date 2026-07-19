// Image generation routes.
//
//   POST /api/generate  STUB (image-gen track — server/image-gen.ts + prompts)
//   POST /api/matting   STUB (image-gen track — server/image/matting.ts)
import type { Hono } from "hono";

export function register(app: Hono): void {
  // TODO(image-gen track): build ref guidance, call generateImage/editImage, save parts/<id>.png.
  app.post("/api/generate", (c) => c.json({ error: "not implemented", todo: "image-gen track" }, 501));

  // TODO(image-gen track): white->black edit + triangulationMatting -> transparent parts/<id>.png.
  app.post("/api/matting", (c) => c.json({ error: "not implemented", todo: "image-gen track" }, 501));
}
