import { Elysia, t } from "elysia";
import { exitIp } from "../../worker/page-tools";
import * as queue from "../../worker/queue";
import {
  consecutiveJobFailures,
  egressHealthy,
  workerReady,
} from "../../worker/loop";

const MAX_IN_FLIGHT_PER_USER = 3;

const SUPPORTED =
  /(^|\.)(datacat\.run|janitorai\.com|janitor\.ai|jannyai\.com|chub\.ai|characterhub\.org|realm\.risuai\.net|lorebary\.com|saucepan\.ai|botbooru\.com|character-tavern\.com|docs\.google\.com)$/i;

// Same chain unorouter reads (src/lib/custom-fetch.ts): Cloudflare sets
// cf-connecting-ip, and the others cover any other hop. Behind cloudflared the
// socket peer is the tunnel, so it is NOT a fallback: it would key every
// caller in the cluster to one bucket. A direct caller can forge these, but
// the only thing forging buys is a share of the cap.
function callerIp(request: Request): string {
  const h = request.headers;
  return (
    h.get("cf-connecting-ip")?.trim() ||
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

export const jobsRoutes = new Elysia()
  .post(
    "/api/jobs",
    ({ body, status, request }) => {
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
      // Keyed on the IP rather than the body's userId: the endpoint takes no
      // token, so a caller-supplied id is a cap you opt out of by changing it.
      const caller = callerIp(request);
      if (queue.inFlightFor(caller) >= MAX_IN_FLIGHT_PER_USER) {
        return status(429, { error: "too many jobs in flight" });
      }
      const job = queue.submit(url.href, caller);
      // Widened to string on purpose: fromTypes resolves the response off the
      // emitted declaration, and a type imported from another module comes
      // through as an unresolved reference, which drops the whole route's
      // response schema from the document without warning.
      return { jobId: job.id, status: job.status as string };
    },
    {
      // userId is accepted and ignored: the cap moved to the client IP, and
      // rejecting it would break unorouter's generated client mid-rollout.
      body: t.Object({
        url: t.String({ minLength: 1, maxLength: 2048 }),
        userId: t.Optional(t.String({ maxLength: 64 })),
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
        result: job.result ?? null,
        error: job.error ?? null,
        // Zero once running, so the client can say "3 ahead of you" instead of
        // showing a spinner that looks identical to a stuck import.
        queuePosition: queue.positionOf(params.id),
      };
    },
    { params: t.Object({ id: t.String() }) },
  )
  // ok reports whether the API can accept work, not whether the last probe
  // passed: a challenged exit is recoverable per job, and failing readiness for
  // it takes the Service out of the cluster's endpoints for no reason.
  // Readiness only: 200 whenever the API can accept work. A challenged exit is
  // recoverable per job, and failing this takes the pod out of the Service so
  // the queue stops accepting the very jobs that would prove egress works.
  .get("/api/health", async () => ({
    ok: true,
    exitUsable: workerReady(),
    exitIp: await exitIp(),
    queueDepth: queue.queueDepth(),
    failStreak: consecutiveJobFailures(),
  }))
  // Liveness only: 503 once egress is persistently dead, so the kubelet
  // restarts the container and gluetun comes back on a fresh tunnel.
  .get("/api/health/live", async ({ status }) => {
    const body = {
      ok: egressHealthy(),
      exitUsable: workerReady(),
      exitIp: await exitIp(),
      queueDepth: queue.queueDepth(),
      failStreak: consecutiveJobFailures(),
    };
    // 503 so the liveness probe can actually restart the pod. Reporting 200 on a
    // dead tunnel is what let an outage run: gluetun was flapping, every job
    // failed, and nothing ever recycled the container.
    return body.ok ? body : status(503, body);
  });
