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
import { fetchGoogleDoc, matchesGoogleDocs } from "../adapters/google-docs";
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
import { fetchJanitorCard, hasJanitorAuth } from "../adapters/janitorai-auth";
import { toEntries } from "../adapters/entries";
import type { ImportResult, ImportResults } from "../types/uniform-card";
import {
  findUsableExit,
  gracefulShutdown,
  probeExit,
  registerBrowserForShutdown,
  rotateVpn,
} from "./page-tools";
import * as queue from "./queue";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// How long one job may keep trying. Generous, because the alternative is
// failing a request that a few more rolls would have served, and the client is
// polling rather than holding a connection open.
const JOB_DEADLINE_MS = 15 * 60_000;
// What one job may spend while others are queued behind it.
const BUSY_JOB_DEADLINE_MS = 90_000;
// Rolls per failure before re-attempting the fetch. Small: a fresh exit is
// worth trying the actual request on rather than spending the budget proving
// exits good with the probe.
const ROLLS_PER_ATTEMPT = 3;
// The exit pool is large and a rejected exit is not a rejected card, so the
// deadline is the ONLY thing that ends a job: capping attempts throws away a
// pool that would have served the request a few rolls later.
//
// What the deadline does not bound is MEMORY. Each attempt loads pages in a
// real Chrome and the tab never gives that back, which is how one job reached
// 1.1GB and OOM-killed the container. Replacing the tab periodically returns
// it, so a long retry costs time instead of the process.
const ATTEMPTS_PER_PAGE = 8;
// Failures that are the upstream's answer rather than the exit's, so a reroll
// cannot change them.
const PERMANENT =
  /^(datacat: (character not indexed|downloads disabled by creator)|janitorai: (lorebook has no importable|script is empty)|lorebary: (downloads disabled|.* not found|.* has no importable|scenario is empty))/;

let page: PageWithCursor | null = null;
let newPage: (() => Promise<PageWithCursor>) | null = null;
let ready = false;
let failStreak = 0;

export const workerReady = () => ready;

// A pod whose tunnel is broken still answers /api/health, so the liveness probe
// kept passing through an outage where EVERY import failed: 82 VPN rerolls, 0
// successes, and gluetun restarting itself three times in 20 seconds. Health has
// to reflect egress or it cannot restart the one thing that fixes this.
//
// Keyed on consecutive whole-JOB failures rather than a live probe: a single
// challenged exit is normal and recoverable per job (which is why ok was a
// literal), but nothing legitimate fails this many jobs back to back.
const DEAD_AFTER_CONSECUTIVE_JOB_FAILURES = 5;

// The streak above only moves when a job SETTLES, and a job retries until its
// deadline: with the tunnel down every attempt burns ~50s in rotateVpn, so one
// job can hold the loop for its full 15 minutes while failStreak sits at 0 and
// liveness stays green. That is the shape of the 2026-09-04 outage, where the
// route install failed silently ("Linux route add command failed" followed by
// "Initialization Sequence Completed"), gluetun restarted itself 119 times, and
// jobs queued for hours behind a worker that never took another one.
//
// So track failing ATTEMPTS too. A rolled exit that cannot reach the open web
// is not a challenged exit, it is no egress at all, and no number of rerolls
// fixes a namespace whose default route is gone.
const DEAD_AFTER_CONSECUTIVE_ATTEMPT_FAILURES = 12;
let attemptFailStreak = 0;

export const egressHealthy = () =>
  failStreak < DEAD_AFTER_CONSECUTIVE_JOB_FAILURES &&
  attemptFailStreak < DEAD_AFTER_CONSECUTIVE_ATTEMPT_FAILURES;

export const consecutiveJobFailures = () => failStreak;
export const consecutiveAttemptFailures = () => attemptFailStreak;

// A list because one URL can hold many items: a Google Docs character book has
// 29, and chub lorebook pages and lorebary scenarios already carried several
// that had to be flattened into one result to fit. Single-item sources wrap
// here rather than in nine adapters, so each adapter stays single-purpose.
async function runJob(job: queue.Job): Promise<ImportResults> {
  const url = new URL(job.url);
  // A standalone lorebook link, checked before the character adapters: both
  // live on janitorai.com and only the path tells them apart.
  if (matchesLorebook(url)) return [await fetchLorebook(page!, url, toEntries)];
  // chub /lorebooks/ before the character adapter: both live on chub.ai and only
  // the first path segment tells them apart.
  if (matchesChubLorebook(url))
    return [await fetchChubLorebook(page!, url, toEntries)];
  // All six lorebary types share one host and differ only by path, so the
  // specific matchers run before the persona one.
  if (matchesLorebaryCharacter(url))
    return [await fetchLorebaryCharacter(page!, url)];
  if (matchesLorebaryLorebook(url))
    return [await fetchLorebaryLorebook(page!, url)];
  if (matchesLorebaryPlugin(url))
    return [await fetchLorebaryPlugin(page!, url)];
  if (matchesLorebaryPrompt(url))
    return [await fetchLorebaryPrompt(page!, url)];
  if (matchesLorebaryScenario(url))
    return [await fetchLorebaryScenario(page!, url)];
  if (matchesLorebary(url)) return [await fetchLorebaryPersona(page!, url)];
  if (png.matchesChub(url)) return [await png.fetchChub(page!, url, toEntries)];
  if (matchesRisu(url)) return [await fetchRisu(page!, url, toEntries)];
  // The only source that returns MANY characters from one URL.
  if (matchesGoogleDocs(url)) return fetchGoogleDoc(page!, url);
  if (matchesBotbooruLorebook(url)) return [await fetchBotbooruLorebook(url)];
  if (matchesBotbooru(url)) return [await fetchBotbooru(url)];
  if (matchesCharacterTavern(url)) return [await fetchCharacterTavern(url)];
  if (matchesSaucepanLorebook(url)) return [await fetchSaucepanLorebook(url)];
  if (matchesSaucepan(url)) return [await fetchSaucepan(url)];
  if (!datacat.matches(url)) throw new Error("unsupported source");

  let fetched;
  try {
    fetched = await datacat.fetchCard(page!, url);
  } catch (err) {
    // datacat only knows what it has crawled, so a character published recently
    // or never indexed 404s there while JanitorAI serves it fine. Ask the source
    // directly before giving up, which needs a signed-in session because a card
    // like this is usually the explicit kind that answers 401 to anonymous.
    // A creator block is datacat's own policy, not the source's: JanitorAI
    // still serves that card to a signed-in session.
    const missing =
      err instanceof Error &&
      /character not indexed|downloads disabled by creator/.test(err.message);
    const id = datacat.characterId(url.href);
    if (!missing || !id || !hasJanitorAuth()) throw err;
    const direct = await fetchJanitorCard(page!, id, url);
    // Rethrow datacat's error rather than inventing one: falling back is a bonus
    // path, and its failure says nothing new about the card.
    if (!direct) throw err;
    return [direct];
  }
  const { card, retryIds } = fetched;

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
  return [card];
}

export async function startWorker() {
  // No --remote-debugging-port here: the driver picks its own and connects to
  // it, and forcing one makes that connection ECONNREFUSED. To inspect a running
  // browser, read the port back out of the process instead:
  //   kubectl exec deploy/uno-import -c api -- sh -c \
  //     'P=$(ps aux | grep -o "\-\-remote-debugging-port=[0-9]*" | head -1 | cut -d= -f2); \
  //      curl -s 127.0.0.1:$P/json | tr "," "\n" | grep url'
  // That is how the tab was caught sitting on disney.com mid-job.
  // No userDataDir: pointing chrome-launcher at the mounted profile made Chrome
  // fail to start at all (the driver's debug port answered ECONNREFUSED and the
  // container crash-looped), so the JanitorAI session is re-established per pod
  // rather than persisted. Revisit only with a profile Chrome will actually open.
  const { browser, page: p } = await connect({ turnstile: true });
  registerBrowserForShutdown(browser);

  // Work on our OWN tab. connect() returns chrome's startup tab, and something
  // in the stack keeps steering it elsewhere: caught over CDP sitting on
  // disney.com with a recaptcha worker while a job was mid-flight. A dedicated
  // page is not touched by that, and the startup tab is left to whatever wants
  // it.
  newPage = async () => {
    const fresh = ((await browser.newPage()) ?? p) as PageWithCursor;
    await fresh.setViewport({ width: 1920, height: 1080 });
    // Confirm datacat's 18+ gate before their scripts run. Its Exit button sets
    // location to disney.com, and the turnstile solver clicks buttons on the
    // page, so an unconfirmed overlay walks the tab off the site about a second
    // after the load succeeds; every relative fetch then 404s from disney.de and
    // reads like the API rejecting us. This sets the same flag Confirm would.
    await fresh.evaluateOnNewDocument(`
      try {
        localStorage.setItem("age_gate_ok", "true");
        sessionStorage.setItem("age_gate_ok", "true");
      } catch (e) {}
    `);
    return fresh;
  };
  page = await newPage();

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
    // But the full deadline is only affordable when nobody is waiting. There is
    // ONE browser, so a job that retries for fifteen minutes holds every other
    // caller behind it, and the per-user cap does not help: the queue in front of
    // you is other people. Jobs with company get the short deadline, which is
    // still ~20 rolls, and the wait is reported rather than looking like a hang.
    const alone = queue.queueDepth() === 0;
    const deadline =
      Date.now() + (alone ? JOB_DEADLINE_MS : BUSY_JOB_DEADLINE_MS);
    let lastError = "";
    for (let attempt = 1; ; attempt++) {
      try {
        queue.finish(job, await runJob(job));
        failStreak = 0;
        attemptFailStreak = 0;
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
        // An upstream verdict says nothing about the tunnel, so it must not
        // push the pod toward a restart.
        if (!direct && !settled) attemptFailStreak++;
        if (Date.now() > deadline || direct || settled) {
          // Only a job that exhausted its whole deadline counts: a permanent
          // upstream verdict (private card, 404) says nothing about egress.
          if (!direct && !settled) failStreak++;
          // Say WHICH deadline ran out. Giving up early because other callers
          // were waiting is a queue problem the user can retry out of, and it
          // reads nothing like the card being missing or private, so reporting
          // the last upstream error alone sends them chasing the wrong thing.
          const gaveUpEarly = !direct && !settled && !alone;
          queue.fail(
            job,
            gaveUpEarly ? `busy: ${lastError}` : lastError,
          );
          break;
        }
        console.warn(`[job] attempt ${attempt} failed: ${lastError}`);
        // Hand the tab's memory back rather than the job's remaining time.
        if (attempt % ATTEMPTS_PER_PAGE === 0 && newPage) {
          try {
            const stale = page;
            page = await newPage();
            await stale?.close();
          } catch {
            // a failed swap leaves the old tab in place, which still works
          }
        }
        // Move FIRST, then find a usable exit. The probe only proves the exit
        // can reach the open web, not that the TARGET still accepts it, so
        // leaving on a passing probe pinned the loop to one rejected address
        // for 200+ attempts. Rotating AFTER the search is worse still: it
        // discards the exit just validated and runs the next attempt while the
        // tunnel is still coming up.
        //
        // A false return means the roll produced no exit IP at all. Rerolling
        // cannot fix that, so end the job now and let the attempt streak carry
        // the pod to a restart instead of spending the deadline on dead time.
        if (!(await rotateVpn())) {
          failStreak++;
          queue.fail(job, `no egress: ${lastError}`);
          break;
        }
        await findUsableExit(page!, ROLLS_PER_ATTEMPT);
      }
    }
  }
}

process.on("unhandledRejection", (e) => {
  console.error("[worker] unhandled", e);
  void gracefulShutdown(1);
});
