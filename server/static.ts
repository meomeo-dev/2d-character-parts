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
// /api/* responses reflect the request Origin only when it is on the allow-list
// (env CORS_ORIGINS, comma-separated; defaults to the loopback host:port). This
// replaces the old wildcard `*`. OPTIONS preflight is answered with 204.
import { readFile } from "node:fs/promises";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono, Next } from "hono";
import { isAuthenticated, setSession } from "./auth.ts";

/** Build the CORS allow-list for the given port from CORS_ORIGINS or defaults. */
function corsAllowList(port: number): Set<string> {
  const env = process.env.CORS_ORIGINS?.trim();
  if (env) {
    return new Set(
      env
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    );
  }
  // Default: loopback on the serving port, both host spellings.
  return new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
}

/**
 * Register the /api CORS middleware. Call before feature routes are added.
 * `port` is used to compute the default loopback allow-list entries.
 */
export function registerCors(app: Hono, port: number): void {
  const allow = corsAllowList(port);

  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("Origin");
    const allowed = origin ? allow.has(origin) : false;

    if (c.req.method === "OPTIONS") {
      const headers: Record<string, string> = {
        "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        Vary: "Origin",
      };
      if (allowed && origin) headers["Access-Control-Allow-Origin"] = origin;
      return c.body(null, 204, headers);
    }

    await next();
    c.header("Vary", "Origin");
    // Same-origin requests carry no Origin header and need no ACAO. Only reflect
    // an Origin we explicitly trust — never echo an arbitrary one.
    if (allowed && origin) c.header("Access-Control-Allow-Origin", origin);
  });
}

/** Register static asset routes. Call after /api routes so they take precedence. */
export function registerStatic(app: Hono): void {
  // Login endpoint: verify the submitted token and set the session cookie.
  app.post("/login", async (c) => {
    let token = "";
    const ctype = c.req.header("Content-Type") ?? "";
    try {
      if (ctype.includes("application/json")) {
        const body = (await c.req.json()) as { token?: unknown };
        token = typeof body.token === "string" ? body.token : "";
      } else {
        const form = await c.req.parseBody();
        token = typeof form.token === "string" ? form.token : "";
      }
    } catch {
      /* fall through to failure */
    }
    // Reuse the cookie check by stuffing the candidate through the bearer path.
    c.req.raw.headers.set("Authorization", `Bearer ${token}`);
    if (!isAuthenticated(c)) {
      return c.html(loginPage("Invalid token 令牌无效"), 401);
    }
    setSession(c);
    return c.redirect("/", 303);
  });

  // SPA entry — gated. No valid session cookie => serve the login page instead
  // of the studio shell, so the app can't be entered without the token.
  app.get("/", async (c) => {
    if (!isAuthenticated(c)) {
      return c.html(loginPage());
    }
    const html = await readFile("./templates/studio.html", "utf8");
    return c.html(html);
  });

  // Force revalidation for the SPA templates (panel JS/CSS). Without an ETag or
  // Cache-Control the browser applies heuristic caching and may keep serving a
  // stale ES module after we edit it — "no-cache" makes it revalidate against
  // Last-Modified every load, so edits show up on a normal refresh.
  app.use("/templates/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-cache");
  });

  // Gate the static trees behind the same session check so the studio shell
  // (/templates/studio.html) and generated content (/parts, /animations) can't
  // be read without a token. The login page is self-contained (inline CSS/JS),
  // so it needs none of these assets. The cookie auto-sends on same-origin, so
  // everything loads normally once logged in.
  app.use("/templates/*", requireAuth);
  app.use("/parts/*", requireAuth);
  app.use("/animations/*", requireAuth);
  // Generated pet atlases (strips, frames, atlas.png, spritesheet.webp) are
  // gated exactly like /animations/* — they carry real generated imagery and
  // must never be readable without a session/bearer token.
  app.use("/pets/*", requireAuth);

  // Static asset trees. `root: "./"` + the prefixed route means the request
  // path (e.g. /templates/panels/index.js) is joined onto the CWD as-is.
  app.get("/templates/*", serveStatic({ root: "./" }));
  app.get("/parts/*", serveStatic({ root: "./" }));
  app.get("/animations/*", serveStatic({ root: "./" }));
  app.get("/pets/*", serveStatic({ root: "./" }));
}

/** Middleware: block static-tree access unless the session/bearer check passes. */
async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  if (!isAuthenticated(c)) return c.text("Unauthorized", 401);
  await next();
}

/**
 * Self-contained login page (inline CSS/JS, no external assets so it works
 * before authentication). Posts the token to /login; on success the server
 * sets the session cookie and redirects to the studio.
 */
function loginPage(error = ""): string {
  const errHtml = error
    ? `<p class="err">${error.replace(/</g, "&lt;")}</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Login — 2D Character Parts</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    background: #f0f2f5; color: #333; height: 100vh;
    display: flex; align-items: center; justify-content: center; }
  .card { background: #fff; padding: 32px; border-radius: 8px;
    box-shadow: 0 2px 16px rgba(0,0,0,.08); width: 340px; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  p.sub { font-size: 13px; color: #888; margin-bottom: 20px; }
  label { display: block; font-size: 13px; margin-bottom: 6px; color: #555; }
  input { width: 100%; padding: 10px 12px; border: 1px solid #e0e0e0;
    border-radius: 6px; font-size: 14px; font-family: monospace; }
  input:focus { outline: none; border-color: #4a90d9; }
  button { width: 100%; margin-top: 16px; padding: 10px;
    background: #4a90d9; color: #fff; border: none; border-radius: 6px;
    font-size: 14px; cursor: pointer; }
  button:hover { background: #357abd; }
  .err { color: #d9534f; font-size: 13px; margin-bottom: 12px; }
  .hint { font-size: 12px; color: #aaa; margin-top: 16px; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <h1>🎨 2D Character Parts</h1>
    <p class="sub">Access token required 需要访问令牌</p>
    ${errHtml}
    <form method="POST" action="/login">
      <label for="token">Token 令牌</label>
      <input id="token" name="token" type="password" autocomplete="off"
        autofocus placeholder="Paste your token 粘贴令牌" />
      <button type="submit">Enter 进入</button>
    </form>
    <p class="hint">The token is printed in the server startup log.<br>令牌打印在服务启动日志中。</p>
  </div>
</body>
</html>`;
}
