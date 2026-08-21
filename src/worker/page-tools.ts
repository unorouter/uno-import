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

export const exitIp = async (): Promise<string> => {
  try {
    const res = await fetch(`${GLUETUN}/v1/publicip/ip`);
    const json = (await res.json()) as { public_ip?: string };
    return json.public_ip ?? "";
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
  for (const url of ["https://datacat.run/", "https://janitorai.com/"]) {
    try {
      await page.goto(url, { waitUntil: "load", timeout: 45000 });
      const title = await page.evaluate("document.title");
      if (
        typeof title === "string" &&
        /just a moment|attention required/i.test(title)
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
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
