import { fromTypes, openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";
import { debugRoutes } from "./api/routes/debug.routes";
import { jobsRoutes } from "./api/routes/jobs.routes";
import { startWorker } from "./worker/loop";

const TOKEN = process.env.API_TOKEN;
if (!TOKEN) throw new Error("API_TOKEN is required");

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
  // Only unorouter submits work. Without this the service is an open browser
  // pointed at other people's sites, which is the sort of thing that gets an
  // exit range blocked for everyone.
  .onBeforeHandle(({ request, path, status }) => {
    if (path === "/api/health") return;
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
