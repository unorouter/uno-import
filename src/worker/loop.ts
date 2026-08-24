import { connect, type PageWithCursor } from "puppeteer-real-browser";
import * as datacat from "../adapters/datacat";
import * as png from "../adapters/png-sources";
import {
  fetchChubLorebook,
  matchesChubLorebook,
} from "../adapters/chub-lorebook";
import {
  fetchLorebaryCharacter,
  fetchLorebaryLorebook,
  fetchLorebaryPersona,
  fetchLorebaryPlugin,
  fetchLorebaryPrompt,
  fetchLorebaryScenario,
  matchesLorebary,
  matchesLorebaryCharacter,
  matchesLorebaryLorebook,
  matchesLorebaryPlugin,
  matchesLorebaryPrompt,
  matchesLorebaryScenario,
} from "../adapters/lorebary";
import { fetchRisu, matchesRisu } from "../adapters/risurealm";
import {
  fetchBotbooru,
  fetchBotbooruLorebook,
  matchesBotbooru,
  matchesBotbooruLorebook,
} from "../adapters/botbooru";
import {
  fetchCharacterTavern,
  matchesCharacterTavern,
} from "../adapters/character-tavern";
import {
  fetchSaucepan,
  fetchSaucepanLorebook,
  matchesSaucepan,
  matchesSaucepanLorebook,
} from "../adapters/saucepan";
import {
  fetchLorebook,
  matchesLorebook,
  recoverLorebooks,
} from "../adapters/janitorai";
import { toEntries } from "../adapters/entries";
import type { ImportResult } from "../types/uniform-card";
import {
  findUsableExit,
  gracefulShutdown,
  probeExit,
  registerBrowserForShutdown,
} from "./page-tools";
import * as queue from "./queue";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// How long one job may keep trying. Generous, because the alternative is
// failing a request that a few more rolls would have served, and the client is
// polling rather than holding a connection open.
const JOB_DEADLINE_MS = 10 * 60_000;
// Rolls per failure before re-attempting the fetch. Small: a fresh exit is
// worth trying the actual request on rather than spending the budget proving
// exits good with the probe.
const ROLLS_PER_ATTEMPT = 3;
// Failures that are the upstream's answer rather than the exit's, so a reroll
// cannot change them.
const PERMANENT =
  /^(janitorai: (lorebook has no importable|script is empty)|lorebary: (downloads disabled|.* not found|.* has no importable|scenario is empty))/;

let page: PageWithCursor | null = null;
let ready = false;

export const workerReady = () => ready;

async function runJob(job: queue.Job): Promise<ImportResult> {
  const url = new URL(job.url);
  // A standalone lorebook link, checked before the character adapters: both
  // live on janitorai.com and only the path tells them apart.
  if (matchesLorebook(url)) return fetchLorebook(page!, url, toEntries);
  // chub /lorebooks/ before the character adapter: both live on chub.ai and only
  // the first path segment tells them apart.
  if (matchesChubLorebook(url)) return fetchChubLorebook(page!, url, toEntries);
  // All six lorebary types share one host and differ only by path, so the
  // specific matchers run before the persona one.
  if (matchesLorebaryCharacter(url)) return fetchLorebaryCharacter(page!, url);
  if (matchesLorebaryLorebook(url)) return fetchLorebaryLorebook(page!, url);
  if (matchesLorebaryPlugin(url)) return fetchLorebaryPlugin(page!, url);
  if (matchesLorebaryPrompt(url)) return fetchLorebaryPrompt(page!, url);
  if (matchesLorebaryScenario(url)) return fetchLorebaryScenario(page!, url);
  if (matchesLorebary(url)) return fetchLorebaryPersona(page!, url);
  if (png.matchesChub(url)) return png.fetchChub(page!, url, toEntries);
  if (matchesRisu(url)) return fetchRisu(page!, url, toEntries);
  if (matchesBotbooruLorebook(url)) return fetchBotbooruLorebook(url);
  if (matchesBotbooru(url)) return fetchBotbooru(url);
  if (matchesCharacterTavern(url)) return fetchCharacterTavern(url);
  if (matchesSaucepanLorebook(url)) return fetchSaucepanLorebook(url);
  if (matchesSaucepan(url)) return fetchSaucepan(url);
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
    console.warn(
      "[worker] startup exit is challenged; jobs will roll on demand",
    );

  setInterval(() => queue.sweep(), 60_000);

  for (;;) {
    const job = queue.take();
    if (!job) {
      await sleep(400);
      continue;
    }
    // Keep rolling until the job succeeds or runs out of time. A fixed number of
    // attempts is the wrong bound here: exits are drawn from a shared pool that
    // is largely flagged at some hours and mostly clean at others, so "5 rolls"
    // is not a measure of anything, and giving up on a working request because
    // the pool was bad for a minute is the failure users actually see.
    //
    // A deadline is the real bound. The queue is per-user rate limited, so a
    // long retry cannot monopolise the browser, and the caller is polling and
    // can give up on its own.
    const deadline = Date.now() + JOB_DEADLINE_MS;
    let lastError = "";
    for (let attempt = 1; ; attempt++) {
      try {
        queue.finish(job, await runJob(job));
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        // These three are fetched directly rather than through the page, so
        // their failures say something about the request and nothing about the
        // exit, and rerolling one would burn the whole deadline on a card that
        // is simply not there.
        const direct = /^(saucepan|botbooru|character-tavern):/.test(lastError);
        // A verdict the upstream gave us at HTTP 200 does not change on a
        // fresh exit, so rerolling one only delays the same answer to the
        // deadline.
        const settled = PERMANENT.test(lastError);
        if (Date.now() > deadline || direct || settled) {
          queue.fail(job, lastError);
          break;
        }
        console.warn(`[job] attempt ${attempt} failed: ${lastError}`);
        // A challenged exit surfaces as a fetch failure from in-page code, so
        // treat any failure as possibly-the-exit and move to a fresh one.
        await findUsableExit(page!, ROLLS_PER_ATTEMPT);
      }
    }
  }
}

process.on("unhandledRejection", (e) => {
  console.error("[worker] unhandled", e);
  void gracefulShutdown(1);
});
