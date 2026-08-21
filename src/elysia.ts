import { openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";
import { debugRoutes } from "./api/routes/debug.routes";
import { jobsRoutes } from "./api/routes/jobs.routes";
import { startWorker } from "./worker/loop";

const TOKEN = process.env.API_TOKEN;
if (!TOKEN) throw new Error("API_TOKEN is required");

export const app = new Elysia()
  .use(openapi())
  // Only unorouter submits work. Without this the service is an open browser
  // pointed at other people's sites, which is the sort of thing that gets an
  // exit range blocked for everyone.
  .onBeforeHandle(({ request, path, status }) => {
    if (path === "/api/health") return;
    // The echo endpoint cannot use our token: the whole point is that a
    // JanitorAI chat posts to it, and that request carries the USER's key, not
    // ours. DEBUG_ECHO is its gate instead, and it 404s while unset.
    if (path === "/api/debug/echo") return;
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
