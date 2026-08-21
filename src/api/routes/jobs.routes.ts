import { Elysia, t } from "elysia";
import { exitIp } from "../../worker/page-tools";
import * as queue from "../../worker/queue";
import { workerReady } from "../../worker/loop";

const MAX_IN_FLIGHT_PER_USER = 3;

const SUPPORTED =
  /(^|\.)(datacat\.run|janitorai\.com|janitor\.ai|jannyai\.com|chub\.ai|characterhub\.org|realm\.risuai\.net)$/i;

export const jobsRoutes = new Elysia()
  .post(
    "/api/jobs",
    ({ body, status }) => {
      let url: URL;
      try {
        url = new URL(body.url);
      } catch {
        return status(400, { error: "invalid url" });
      }
      if (url.protocol !== "https:")
        return status(400, { error: "https only" });
      if (!SUPPORTED.test(url.hostname)) {
        return status(400, { error: "unsupported source" });
      }
      // Per-user concurrency, not a lifetime quota: one caller should not be
      // able to fill a single-browser queue on everyone else's behalf.
      if (queue.inFlightFor(body.userId) >= MAX_IN_FLIGHT_PER_USER) {
        return status(429, { error: "too many jobs in flight" });
      }
      const job = queue.submit(url.href, body.userId);
      // Widened to string on purpose: fromTypes resolves the response off the
      // emitted declaration, and a type imported from another module comes
      // through as an unresolved reference, which drops the whole route's
      // response schema from the document without warning.
      return { jobId: job.id, status: job.status as string };
    },
    {
      body: t.Object({
        url: t.String({ minLength: 1, maxLength: 2048 }),
        userId: t.String({ minLength: 1, maxLength: 64 }),
      }),
    },
  )
  .get(
    "/api/jobs/:id",
    ({ params, status }) => {
      const job = queue.get(params.id);
      if (!job) return status(404, { error: "not found" });
      return {
        status: job.status as string,
        // The card is documented as an open object rather than the full
        // UniformCard: same reason as above, a cross-module type reference
        // silently costs the route its schema. The shape is in uniform-card.ts.
        result: (job.result ?? null) as Record<string, unknown> | null,
        error: job.error ?? null,
      };
    },
    { params: t.Object({ id: t.String() }) },
  )
  // ok reports whether the API can accept work, not whether the last probe
  // passed: a challenged exit is recoverable per job, and failing readiness for
  // it takes the Service out of the cluster's endpoints for no reason.
  .get("/api/health", async () => ({
    ok: true,
    exitUsable: workerReady(),
    exitIp: await exitIp(),
    queueDepth: queue.queueDepth(),
  }));
