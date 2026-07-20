// Unified Node/ai-sdk backend — entry point.
//
// Replaces the Python http.server studio. Serves the SPA + static assets and
// all /api routes. LLM chat and image generation go through the AI SDK; model
// listing is handled separately (see models.ts).
//
// Route registry: each feature module under routes/ exports `register(app)` and
// adds its own Hono routes. Adding a track means filling in an existing stub —
// no edits to this file. /api CORS is installed first, then feature routes, then
// static assets (so /api takes precedence over the static trees).
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { registerCors, registerStatic } from "./static.ts";
import { getToken, registerAuth, tokenFromEnv } from "./auth.ts";
import { register as registerProviders } from "./routes/providers.ts";
import { register as registerChat } from "./routes/chat.ts";
import { register as registerPrompts } from "./routes/prompts.ts";
import { register as registerImagegen } from "./routes/imagegen.ts";
import { register as registerAnimation } from "./routes/animation.ts";
import { register as registerJina } from "./routes/jina.ts";

const app = new Hono();

const port = Number(process.env.PORT ?? 8765);
const hostname = process.env.HOST ?? "127.0.0.1";

// CORS on /api/* first so it wraps every API response, then the bearer-token
// guard (OPTIONS preflight is answered by CORS and never reaches the guard).
registerCors(app, port);
registerAuth(app);

// Feature route groups. providers is fully implemented (config/providers/models);
// the rest are stubs returning 501 until their track lands.
registerProviders(app);
registerChat(app);
registerPrompts(app);
registerImagegen(app);
registerAnimation(app);
registerJina(app);

// Static assets last (SPA shell + templates/parts/animations trees).
registerStatic(app);

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`\n  🎨 2D Character Parts — Node/ai-sdk backend`);
  console.log(`  URL: http://${hostname}:${info.port}`);
  const src = tokenFromEnv() ? "from AUTH_TOKEN env" : "generated this run";
  console.log(`  Auth token (${src}): ${getToken()}`);
  console.log(`  Open the URL in a browser — the page authenticates itself.`);
  console.log(`  For curl/scripts: -H "Authorization: Bearer <token>"\n`);
});
