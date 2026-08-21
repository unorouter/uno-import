import { connect, type PageWithCursor } from "puppeteer-real-browser";
import * as datacat from "../adapters/datacat";
import * as png from "../adapters/png-sources";
import { recoverLorebooks } from "../adapters/janitorai";
import { toEntries } from "../adapters/entries";
import type { UniformCard } from "../types/uniform-card";
import {
  findUsableExit,
  gracefulShutdown,
  probeExit,
  registerBrowserForShutdown,
} from "./page-tools";
import * as queue from "./queue";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let page: PageWithCursor | null = null;
let ready = false;

export const workerReady = () => ready;

async function runJob(job: queue.Job): Promise<UniformCard> {
  const url = new URL(job.url);
  if (png.matchesChub(url)) return png.fetchChub(page!, url);
  if (png.matchesRisu(url)) return png.fetchRisu(page!, url);
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
  // No --remote-debugging-port here: the driver picks its own and connects to
  // it, and forcing one makes that connection ECONNREFUSED. To inspect a running
  // browser, read the port back out of the process instead:
  //   kubectl exec deploy/uno-import -c api -- sh -c \
  //     'P=$(ps aux | grep -o "\-\-remote-debugging-port=[0-9]*" | head -1 | cut -d= -f2); \
  //      curl -s 127.0.0.1:$P/json | tr "," "\n" | grep url'
  // That is how the tab was caught sitting on disney.com mid-job.
  const { browser, page: p } = await connect({ turnstile: true });
  registerBrowserForShutdown(browser);

  // Work on our OWN tab. connect() returns chrome's startup tab, and something
  // in the stack keeps steering it elsewhere: caught over CDP sitting on
  // disney.com with a recaptcha worker while a job was mid-flight. A dedicated
  // page is not touched by that, and the startup tab is left to whatever wants
  // it.
  page = ((await browser.newPage()) ?? p) as PageWithCursor;
  await page.setViewport({ width: 1920, height: 1080 });

  // Confirm datacat's 18+ gate before their scripts run. Its Exit button sets
  // location to disney.com, and the turnstile solver clicks buttons on the page,
  // so an unconfirmed overlay walks the tab off the site about a second after
  // the load succeeds; every relative fetch then 404s from disney.de and reads
  // like the API rejecting us. This sets the same flag Confirm would.
  await page.evaluateOnNewDocument(`
    try {
      localStorage.setItem("age_gate_ok", "true");
      sessionStorage.setItem("age_gate_ok", "true");
    } catch (e) {}
  `);

  // Probe once, but do NOT roll at startup. Rotating rebuilds gluetun's
  // firewall, and inbound rules go with it, so a pod that rolls on boot is
  // unreachable from the cluster for as long as the search runs and reports
  // itself unhealthy the whole time. Jobs roll on demand instead.
  ready = await probeExit(page);
  if (!ready)
    console.warn("[worker] startup exit is challenged; jobs will roll on demand");

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
