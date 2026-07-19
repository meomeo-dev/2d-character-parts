// Static asset serving + /api CORS, ported from the Python studio handler.
//
// The Python server ran with the project root as its CWD and served files
// straight off disk. We mirror that with @hono/node-server/serve-static, whose
// `root` is resolved relative to the process CWD (the worktree root, since
// `npm start` runs `tsx server/index.ts` from there).
//
// Route map:
//   GET /               -> templates/studio.html
//   GET /templates/*    -> templates/...   (panels/*.js, exploded_view.svg, viewer.html)
//   GET /parts/*        -> parts/...       (generated part PNGs)
//   GET /animations/*   -> animations/...  (generated sprite sheets + GIFs)
//
// All /api/* responses carry `Access-Control-Allow-Origin: *`, matching the
// Python _json_response headers. OPTIONS preflight is answered with 204.
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";

/** Register the /api CORS middleware. Call before feature routes are added. */
export function registerCors(app: Hono): void {
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
    }
    await next();
    c.header("Access-Control-Allow-Origin", "*");
  });
}

/** Register static asset routes. Call after /api routes so they take precedence. */
export function registerStatic(app: Hono): void {
  // SPA entry — serve the studio shell at the root.
  app.get("/", serveStatic({ path: "./templates/studio.html" }));

  // Force revalidation for the SPA templates (panel JS/CSS). Without an ETag or
  // Cache-Control the browser applies heuristic caching and may keep serving a
  // stale ES module after we edit it — "no-cache" makes it revalidate against
  // Last-Modified every load, so edits show up on a normal refresh.
  app.use("/templates/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-cache");
  });

  // Static asset trees. `root: "./"` + the prefixed route means the request
  // path (e.g. /templates/panels/index.js) is joined onto the CWD as-is.
  app.get("/templates/*", serveStatic({ root: "./" }));
  app.get("/parts/*", serveStatic({ root: "./" }));
  app.get("/animations/*", serveStatic({ root: "./" }));
}
