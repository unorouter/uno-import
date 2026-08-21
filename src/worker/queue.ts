import type { ImportResult } from "../types/uniform-card";

export type JobStatus = "queued" | "running" | "done" | "failed";

export type Job = {
  id: string;
  url: string;
  userId: string;
  status: JobStatus;
  createdAt: number;
  finishedAt?: number;
  result?: ImportResult;
  error?: string;
};

// Deliberately in-memory and deliberately lossy. A pod restart drops the queue
// and the user resubmits; persisting it would buy a retry of something that
// takes seconds, at the cost of a datastore holding other people's requests.
const jobs = new Map<string, Job>();
const pending: string[] = [];

const MAX_JOBS = 500;
const FINISHED_TTL_MS = 10 * 60_000;

export function submit(url: string, userId: string): Job {
  const job: Job = {
    id: crypto.randomUUID(),
    url,
    userId,
    status: "queued",
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  pending.push(job.id);
  return job;
}

export const get = (id: string) => jobs.get(id);
export const queueDepth = () => pending.length;

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

export function finish(job: Job, result: ImportResult) {
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
// live jobs only, so it throttles concurrency rather than lifetime usage.
export function inFlightFor(userId: string): number {
  let n = 0;
  for (const j of jobs.values()) {
    if (
      j.userId === userId &&
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
    if (job.finishedAt && now - job.finishedAt > FINISHED_TTL_MS)
      jobs.delete(id);
  }
  if (jobs.size <= MAX_JOBS) return;
  const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const job of oldest.slice(0, jobs.size - MAX_JOBS)) jobs.delete(job.id);
}
