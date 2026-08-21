import { connect, type PageWithCursor } from "puppeteer-real-browser";
import * as datacat from "../adapters/datacat";
import { recoverLorebooks } from "../adapters/janitorai";
import { toEntries } from "../adapters/entries";
import type { UniformCard } from "../types/uniform-card";
import {
  findUsableExit,
  gracefulShutdown,
  registerBrowserForShutdown,
} from "./page-tools";
import * as queue from "./queue";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let page: PageWithCursor | null = null;
let ready = false;

export const workerReady = () => ready;

async function runJob(job: queue.Job): Promise<UniformCard> {
  const url = new URL(job.url);
  if (!datacat.matches(url)) throw new Error("unsupported source");

  const { card, retryIds } = await datacat.fetchCard(page!, url);

  // Ask JanitorAI for the books datacat could not fetch. Anything still missing
  // stays in `skipped`, which is what the UI shows the user by name.
  if (retryIds.length > 0) {
    const recovered = await recoverLorebooks(page!, retryIds, toEntries);
    for (const book of recovered) {
      card.lorebooks.push(book);
      const i = card.skipped.findIndex((s) => s.title === book.name);
      if (i >= 0) card.skipped.splice(i, 1);
    }
  }
  return card;
}

export async function startWorker() {
  const { browser, page: p } = await connect({ turnstile: true });
  registerBrowserForShutdown(browser);
  page = p;
  await page.setViewport({ width: 1920, height: 1080 });

  // Roll to an exit that can actually load the targets before accepting work,
  // so the first user request does not pay for the search.
  ready = await findUsableExit(page);
  if (!ready)
    console.error("[worker] no usable exit at startup; will retry per job");

  setInterval(() => queue.sweep(), 60_000);

  for (;;) {
    const job = queue.take();
    if (!job) {
      await sleep(400);
      continue;
    }
    try {
      queue.finish(job, await runJob(job));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A challenged exit looks like a fetch failure from in-page code, so treat
      // the first failure as possibly-the-exit and retry once on a fresh one.
      if (await findUsableExit(page!, 5)) {
        try {
          queue.finish(job, await runJob(job));
          continue;
        } catch (retryErr) {
          queue.fail(
            job,
            retryErr instanceof Error ? retryErr.message : String(retryErr),
          );
          continue;
        }
      }
      queue.fail(job, message);
    }
  }
}

process.on("unhandledRejection", (e) => {
  console.error("[worker] unhandled", e);
  void gracefulShutdown(1);
});
