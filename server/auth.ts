// Bearer-token / session-cookie auth for the local studio.
//
// The server binds to 127.0.0.1 by default; the threat model is *other local
// web pages* in the same browser plus anyone who can reach the port. Access is
// gated by a token printed at startup:
//
//   - Browser: visiting `/` without a valid session cookie returns a login page.
//     Submitting the correct token sets an HttpOnly, SameSite=Strict cookie; only
//     then does `/` serve the studio shell. The cookie is JS-invisible (HttpOnly)
//     and not sent cross-site (SameSite=Strict).
//   - Scripts/curl: send `Authorization: Bearer <token>` — no cookie needed.
//
// Token source:
//   - AUTH_TOKEN env, if set (stable across restarts — handy for scripts/curl)
//   - otherwise a fresh random 32-byte hex token generated at startup
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";

export const SESSION_COOKIE = "studio_session";

let token = "";

/** Resolve the active token, generating a random one on first use if unset. */
export function getToken(): string {
  if (!token) {
    token = process.env.AUTH_TOKEN?.trim() || randomBytes(32).toString("hex");
  }
  return token;
}

/** Whether the token was supplied via env (vs. freshly generated this run). */
export function tokenFromEnv(): boolean {
  return Boolean(process.env.AUTH_TOKEN?.trim());
}

/** Constant-time compare so a wrong guess can't be timed byte-by-byte. */
function tokenMatches(candidate: string): boolean {
  const expected = getToken();
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractBearer(header: string | undefined): string {
  if (!header) return "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() ?? "";
}

/** True when the request carries a valid session cookie OR bearer token. */
export function isAuthenticated(c: Context): boolean {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie && tokenMatches(cookie)) return true;
  const bearer = extractBearer(c.req.header("Authorization"));
  return Boolean(bearer && tokenMatches(bearer));
}

/** Set the HttpOnly session cookie after a successful login. */
export function setSession(c: Context): void {
  setCookie(c, SESSION_COOKIE, getToken(), {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    // Loopback HTTP has no TLS, so Secure would drop the cookie. Enable it when
    // fronted by HTTPS via SECURE_COOKIE=1.
    secure: process.env.SECURE_COOKIE === "1",
    maxAge: 60 * 60 * 24 * 7,
  });
}

/**
 * Guard every /api/* request. Register AFTER CORS (so OPTIONS preflight is
 * answered by CORS and never reaches here) and BEFORE feature routes.
 */
export function registerAuth(app: Hono): void {
  app.use("/api/*", async (c, next) => {
    if (!isAuthenticated(c)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });
}
