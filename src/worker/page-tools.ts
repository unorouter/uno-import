// VPN + browser plumbing, ported from disboard-scrape/src/lib/page-tools.ts and
// backup/2api/glm-proxy. The comments below are incidents, not theory.

import type { PageWithCursor } from "puppeteer-real-browser";

// gluetun's control server. localhost because every container in the pod shares
// the VPN network namespace.
const GLUETUN = "http://127.0.0.1:8000";

// Reaching these routes unauthenticated requires the auth config mounted at
// /gluetun/auth/config.toml. Without it the control API answers "Unauthorized",
// the rotate calls silently no-op, and the exit IP never changes: eight rolls
// against one address, all failing, with nothing in any log to say why.
const setVpn = async (status: "stopped" | "running") => {
  const res = await fetch(`${GLUETUN}/v1/vpn/status`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`vpn ${status}: HTTP ${res.status}`);
};

// gluetun's own lookup returns an empty string whenever its upstream IP service
// fails, which says nothing about whether the tunnel is up, so fall back to
// resolving the exit directly rather than reporting a healthy tunnel as blank.
export const exitIp = async (): Promise<string> => {
  try {
    const res = await fetch(`${GLUETUN}/v1/publicip/ip`);
    const json = (await res.json()) as { public_ip?: string };
    if (json.public_ip) return json.public_ip;
  } catch {}
  try {
    return (await (await fetch("https://api.ipify.org")).text()).trim();
  } catch {
    return "";
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Stop then start rather than restarting the container: the browser survives, so
// an in-flight job can be retried on the new exit instead of dying with it.
export const rotateVpn = async (): Promise<boolean> => {
  try {
    await setVpn("stopped");
    await sleep(3000);
    await setVpn("running");
    await sleep(14000); // reconnect plus public-ip settle
    return true;
  } catch {
    return false;
  }
};

// The gate is a real page load, not a status code. Cloudflare answers our exits
// with a JS challenge (`challenge-platform` in the body, no "you have been
// blocked"), so curl reports 403 on every exit forever while a browser passes:
// probing with fetch would rotate until it ran out of rolls and conclude the
// whole provider was down.
export async function probeExit(page: PageWithCursor): Promise<boolean> {
  // datacat ONLY. janitorai deliberately is not a gate: it answers most exits
  // with a JS challenge that the browser clears per request, so requiring it
  // here rejects exits that work and the loop rotates until it gives up. datacat
  // is also the source that must work, since it carries the card.
  //
  // /fresh, not /: the root 302s and the redirect destroys the execution context
  // that evaluate() is about to run in.
  try {
    await gotoOrigin(page, "https://datacat.run/fresh", 1);
    const title = await page.evaluate("document.title");
    return !(
      typeof title === "string" &&
      /just a moment|attention required/i.test(title)
    );
  } catch {
    return false;
  }
}

// Roll until both targets load, or give up and let the caller back off. Bounded
// because exhausting the rolls usually means the tunnel itself is down, and
// spinning on that starves every queued job.
export async function findUsableExit(
  page: PageWithCursor,
  maxRolls = 10,
): Promise<boolean> {
  for (let n = 0; n <= maxRolls; n++) {
    if (await probeExit(page)) {
      console.log(`[vpn] usable exit ${await exitIp()} after ${n} roll(s)`);
      return true;
    }
    console.log(
      `[vpn] exit ${await exitIp()} challenged, rerolling (${n + 1}/${maxRolls})`,
    );
    if (!(await rotateVpn())) return false;
  }
  return false;
}

// The tab does not stay where it is put: inspected over CDP mid-job it had moved
// to https://www.disney.com/ with a recaptcha webworker alongside it, so a
// relative fetch ran against an origin with no such route and returned 404s that
// read exactly like the target rejecting the request. Verifying after goto is
// not enough, because the drift happens between that check and the evaluate.
export async function gotoOrigin(
  page: PageWithCursor,
  url: string,
  attempts = 3,
): Promise<void> {
  const origin = new URL(url).origin;
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      // Single-page apps rewrite the URL after boot, so settle before reading it.
      await new Promise((r) => setTimeout(r, 2000));
      if (page.url().startsWith(origin)) return;
    } catch {
      if (i === attempts) throw new Error(`navigation to ${url} failed`);
    }
    await new Promise((r) => setTimeout(r, 1000 * i));
  }
  throw new Error(`navigation to ${url} landed on ${page.url()}`);
}

// Evaluate only while the page is still on the expected origin, re-navigating if
// it drifted in between. Without the recheck the script runs wherever the tab
// ended up, and the failure surfaces as a confusing HTTP status from the site we
// never actually asked.
export async function evaluateOn<T>(
  page: PageWithCursor,
  url: string,
  script: string,
): Promise<T> {
  const origin = new URL(url).origin;
  if (!page.url().startsWith(origin)) await gotoOrigin(page, url);
  const result = (await page.evaluate(script)) as T;
  if (!page.url().startsWith(origin)) {
    throw new Error(`page drifted to ${page.url()} during evaluate`);
  }
  return result;
}

type ClosableBrowser = { close: () => Promise<void> };
let registered: ClosableBrowser | null = null;

// Without this a SIGTERM leaves headless chrome running with enormous virtual
// memory, and the orphans accumulate across restarts until the node suffers.
export function registerBrowserForShutdown(browser: ClosableBrowser) {
  registered = browser;
}

let shuttingDown = false;
export async function gracefulShutdown(code = 0): Promise<never> {
  if (shuttingDown) await sleep(60_000);
  shuttingDown = true;
  try {
    await registered?.close();
  } catch {}
  process.exit(code);
}

process.on("SIGTERM", () => void gracefulShutdown());
process.on("SIGINT", () => void gracefulShutdown());
