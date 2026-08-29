import type { ImportResult } from "../types/uniform-card";

export type JobStatus = "queued" | "running" | "done" | "failed";

export type Job = {
  id: string;
  url: string;
  // Whoever submitted, for the concurrency cap alone. The client IP now, since
  // the endpoint is callable without a token and a body field would be a cap
  // anyone could opt out of by varying it.
  caller: string;
  status: JobStatus;
  createdAt: number;
  finishedAt?: number;
  result?: ImportResult[];
  error?: string;
};

// Deliberately in-memory and deliberately lossy. A pod restart drops the queue
// and the user resubmits; persisting it would buy a retry of something that
// takes seconds, at the cost of a datastore holding other people's requests.
const jobs = new Map<string, Job>();
const pending: string[] = [];

const MAX_JOBS = 500;
const FINISHED_TTL_MS = 10 * 60_000;
// Comfortably past the worker's own 15-minute deadline, so this only fires for
// a job the worker will never settle (crashed mid-run, lost to a pod restart).
const STUCK_TTL_MS = 20 * 60_000;

export function submit(url: string, caller: string): Job {
  const job: Job = {
    id: crypto.randomUUID(),
    url,
    caller,
    status: "queued",
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  pending.push(job.id);
  return job;
}

export const get = (id: string) => jobs.get(id);
export const queueDepth = () => pending.length;

// How many jobs are ahead of this one. A queued job is otherwise indistinguishable
// from a hung one: the browser is single-threaded, so waiting is normal and worth
// reporting rather than leaving the caller to guess.
export function positionOf(id: string): number {
  const i = pending.indexOf(id);
  return i < 0 ? 0 : i + 1;
}

export function take(): Job | null {
  while (pending.length) {
    const job = jobs.get(pending.shift()!);
    if (job && job.status === "queued") {
      job.status = "running";
      return job;
    }
  }
  return null;
}

export function finish(job: Job, result: ImportResult[]) {
  job.status = "done";
  job.result = result;
  job.finishedAt = Date.now();
}

export function fail(job: Job, error: string) {
  job.status = "failed";
  job.error = error;
  job.finishedAt = Date.now();
}

// One caller may not fill the queue on everyone else's behalf. Counted over
// live jobs only, so it throttles concurrency rather than lifetime usage. The
// worker runs ONE browser page serially, so an uncapped caller does not slow
// imports down, it stops them for everyone until its jobs drain.
export function inFlightFor(caller: string): number {
  let n = 0;
  for (const j of jobs.values()) {
    if (
      j.caller === caller &&
      (j.status === "queued" || j.status === "running")
    )
      n++;
  }
  return n;
}

// Without eviction the map is a slow leak: every result holds a full card, and
// a card can be a quarter of a megabyte.
export function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    // A live job has no finishedAt, so the TTL below can never reclaim it: one
    // that never settles counts against its owner's in-flight cap forever, and
    // after three of them every further import is refused. That is not
    // hypothetical, it is what a wedged job did to a user. Nothing legitimately
    // outlives the worker's own deadline, so past it the job is declared dead.
    if (!job.finishedAt && now - job.createdAt > STUCK_TTL_MS) {
      job.status = "failed";
      job.error = "timed out";
      job.finishedAt = now;
      continue;
    }
    if (job.finishedAt && now - job.finishedAt > FINISHED_TTL_MS)
      jobs.delete(id);
  }
  if (jobs.size <= MAX_JOBS) return;
  const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const job of oldest.slice(0, jobs.size - MAX_JOBS)) jobs.delete(job.id);
}
