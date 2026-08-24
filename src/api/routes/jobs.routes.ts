import { Elysia, t } from "elysia";
import { exitIp } from "../../worker/page-tools";
import * as queue from "../../worker/queue";
import { workerReady } from "../../worker/loop";

const MAX_IN_FLIGHT_PER_USER = 3;

const SUPPORTED =
  /(^|\.)(datacat\.run|janitorai\.com|janitor\.ai|jannyai\.com|chub\.ai|characterhub\.org|realm\.risuai\.net|lorebary\.com|saucepan\.ai|botbooru\.com|character-tavern\.com)$/i;

// Behind cloudflared, so the socket address is the tunnel. The client is the
// first hop of the forwarded chain, which Cloudflare sets itself; a direct
// caller can forge it, but the only thing it buys is a share of the cap.
function callerIp(request: Request, socketIp: string | undefined): string {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return socketIp ?? "unknown";
}

export const jobsRoutes = new Elysia()
  .post(
    "/api/jobs",
    ({ body, status, request, server }) => {
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
      const caller = callerIp(request, server?.requestIP(request)?.address);
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
