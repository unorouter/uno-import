// Ported from disboard-scrape/src/lib/browser.ts. puppeteer-real-browser is
// abandoned and detected: its tabs sat on JanitorAI's "Please wait" page.

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "rebrowser-puppeteer-core";

const CHROME_PATHS = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Cloudflare fails every headless run, so a box without a screen runs Chrome on Xvfb.
async function ensureDisplay() {
  if (process.platform !== "linux" || process.env.DISPLAY) return;
  const display = ":99";
  const socket = "/tmp/.X11-unix/X99";
  // A restart keeps /tmp, and a stale lock makes Xvfb refuse to start.
  rmSync("/tmp/.X99-lock", { force: true });
  rmSync(socket, { force: true });
  const xvfb = spawn(
    "Xvfb",
    [display, "-screen", "0", "1920x1080x24", "-nolisten", "tcp"],
    { stdio: "ignore", detached: true },
  );
  xvfb.unref();
  process.env.DISPLAY = display;
  for (let i = 0; i < 50 && !existsSync(socket); i++) await sleep(200);
}

const launchWith = (userDataDir?: string) =>
  puppeteer.launch({
    headless: false,
    executablePath: CHROME_PATHS.find((p) => existsSync(p)),
    userDataDir,
    defaultViewport: null,
    args: ["--no-sandbox", "--window-size=1920,1080", "--lang=en-US"],
  });

// The profile keeps cf_clearance and the JanitorAI session across restarts.
export async function launchBrowser(): Promise<Browser> {
  await ensureDisplay();
  const dir = process.env.BROWSER_PROFILE_DIR;
  if (!dir) return launchWith();
  // The volume outlives the container, and Chrome refuses a profile whose
  // Singleton lock names a dead process.
  for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    rmSync(join(dir, lock), { force: true });
  }
  try {
    return await launchWith(dir);
  } catch (err) {
    console.warn(`[browser] profile ${dir} failed (${err}), launching without`);
    return launchWith();
  }
}

export const onChallengePage = async (page: Page) =>
  /just a moment|please wait/i.test(await page.title().catch(() => ""));

// Turnstile's iframe sits in a closed shadow root, so click by coordinates.
export async function clickTurnstile(page: Page): Promise<boolean> {
  const frame = page
    .frames()
    .find((f) => f.url().includes("challenges.cloudflare.com"));
  if (!frame) return false;
  const box = await (await frame.frameElement())?.boundingBox();
  if (!box) return false;
  await page.mouse.click(box.x + 28, box.y + box.height / 2);
  return true;
}

// Wait on the challenge instead of reloading it: a reload starts a new one.
export async function passChallenge(
  page: Page,
  timeoutMs = 45_000,
): Promise<boolean> {
  const start = Date.now();
  let lastClick = 0;
  while (Date.now() - start < timeoutMs) {
    if (!(await onChallengePage(page))) return true;
    if (
      Date.now() - lastClick > 6000 &&
      (await clickTurnstile(page).catch(() => false))
    ) {
      lastClick = Date.now();
    }
    await sleep(1000);
  }
  return false;
}
