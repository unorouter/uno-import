import type { Page } from "rebrowser-puppeteer-core";
import { passChallenge } from "../worker/browser";

// The site has moved between these domains (janitorai.com on registrar hold
// 2026-11-19, jani.com redirecting back by 2026-11-26), so whichever one answers
// is used. Links to any of them still import.
const ORIGINS = ["https://janitorai.com", "https://jani.com"];
let live = ORIGINS[0];

export const JANITOR_AVATARS = "https://janitorsunite.b-cdn.net/bot-avatars/";
export const isJanitorHost = (host: string) =>
  /(^|\.)(janitorai\.com|janitor\.ai|jani\.com)$/i.test(host);
export const janitorOrigin = () => live;

export function onJanitor(page: Page): boolean {
  try {
    return isJanitorHost(new URL(page.url()).hostname);
  } catch {
    return false;
  }
}

export async function gotoJanitor(page: Page, path = "/"): Promise<void> {
  const order = [live, ...ORIGINS.filter((o) => o !== live)];
  for (const origin of [...order, ...order]) {
    try {
      await page.goto(origin + path, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      await passChallenge(page);
      await new Promise((r) => setTimeout(r, 2000));
      if (onJanitor(page)) {
        live = new URL(page.url()).origin;
        return;
      }
    } catch {}
  }
  throw new Error(`navigation to ${path} failed on ${ORIGINS.join(" and ")}`);
}
