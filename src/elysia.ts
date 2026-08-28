import { cors } from "@elysiajs/cors";
import { fromTypes, openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";
import { debugRoutes } from "./api/routes/debug.routes";
import { jobsRoutes } from "./api/routes/jobs.routes";
import { startWorker } from "./worker/loop";

const TOKEN = process.env.API_TOKEN;
if (!TOKEN) throw new Error("API_TOKEN is required");

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
if (ALLOWED_ORIGINS.length === 0) throw new Error("CORS_ORIGINS is required");

const corsOrigin = ALLOWED_ORIGINS.includes("*")
  ? true
  : (request: Request) => {
      const origin = request.headers.get("origin");
      return !!origin && ALLOWED_ORIGINS.includes(origin);
    };

export const app = new Elysia()
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

  .use(
    cors({
      origin: corsOrigin,
      // authorization is required for the echo surface: the token now gates it,
      // and a browser client (JanitorAI's custom proxy) sends that as a header,
      // so omitting it here fails the preflight before the request is made.
      allowedHeaders: ["content-type", "authorization"],
      credentials: false,
      exposeHeaders: [],
    }),
  )

  .onBeforeHandle(({ request, path, status }) => {
    // Both health routes are public: the kubelet probes them with no token,
    // and a 401 on the liveness route restarts a healthy pod every period.
    if (path === "/api/health" || path === "/api/health/live") return;
    if (path === "/api/jobs" || path.startsWith("/api/jobs/")) return;
    // The OpenAI-shaped debug routes are deliberately NOT exempt: they record
    // prompt text, so they need the token like everything else.
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

void startWorker().catch((e) => {
  console.error("[worker] failed to start:", e);
  process.exit(1);
});
