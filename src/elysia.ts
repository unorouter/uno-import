import { cors } from "@elysiajs/cors";
import { fromTypes, openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";
import { debugRoutes } from "./api/routes/debug.routes";
import { jobsRoutes } from "./api/routes/jobs.routes";
import { startWorker } from "./worker/loop";

const TOKEN = process.env.API_TOKEN;
if (!TOKEN) throw new Error("API_TOKEN is required");

// Browsers may call the open import endpoints straight from a page, without
// going through unorouter's BFF. This is NOT access control (a non-browser
// caller sends whatever Origin it likes, and the endpoints are open anyway);
// it only tells real browsers they are allowed to read the response.
//
// Comma-separated exact origins, or "*" for any. Cheaper to widen here than to
// ship an image when a new front-end host appears.
const ALLOWED_ORIGINS = (
  process.env.CORS_ORIGINS ?? "http://localhost:3000,https://unorouter.com"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const corsOrigin = ALLOWED_ORIGINS.includes("*")
  ? true
  : (request: Request) => {
      const origin = request.headers.get("origin");
      return !!origin && ALLOWED_ORIGINS.includes(origin);
    };

export const app = new Elysia()
  // Response schemas are derived from the handlers' own return types, so the
  // document cannot drift from the code. fromTypes reads an EMITTED
  // declaration in production and the SOURCE in dev; a path that does not
  // exist yields paths with no response bodies rather than an error, which
  // looks like it worked until a generated client comes out as `unknown`.
  // The image runs `bun run build` to write dist/elysia.d.ts.
  .use(
    openapi({
      documentation: { openapi: "3.1.0" },
      references: fromTypes(
        process.env.NODE_ENV === "production"
          ? "dist/elysia.d.ts"
          : "src/elysia.ts",
      ),
    }),
  )
  // credentials off: these endpoints carry no cookie and no token, and allowing
  // them would be the one CORS setting that actually widens what a page can do.
  .use(
    cors({
      origin: corsOrigin,
      allowedHeaders: ["content-type"],
      credentials: false,
      exposeHeaders: [],
    }),
  )
  // The import endpoints are open: the fetch target is whitelisted to a fixed
  // list of card sites, so this cannot be pointed at the wider web, and a
  // per-IP concurrency cap keeps one caller off the single browser. Everything
  // else still needs the token, since the debug surface is not for the public.
  .onBeforeHandle(({ request, path, status }) => {
    if (path === "/api/health") return;
    if (path === "/api/jobs" || path.startsWith("/api/jobs/")) return;
    // The echo endpoints cannot use our token: the whole point is that a
    // JanitorAI chat posts to them, and that request carries the USER's key,
    // not ours. DEBUG_ECHO is their gate instead, and they 404 while unset.
    if (path.endsWith("/chat/completions") || path === "/v1/models") return;
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return status(401, { error: "unauthorized" });
    }
  })
  .onError(({ error, path }) => {
    console.error(
      `[api] ${path}:`,
      error instanceof Error ? error.message : error,
    );
  })
  .use(jobsRoutes)
  .use(debugRoutes)
  .listen(4000, () => console.log("[api] listening on :4000"));

// Chromium and the tunnel take time to become usable, so the worker starts
// alongside the server rather than gating it: /api/health reports readiness.
void startWorker().catch((e) => {
  console.error("[worker] failed to start:", e);
  process.exit(1);
});
