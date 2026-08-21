import type { PageWithCursor } from "puppeteer-real-browser";
import type {
  SkippedLorebook,
  UniformCard,
  UniformLorebook,
} from "../types/uniform-card";
import { toEntries } from "./entries";

const UUID_RE = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;

export const matches = (url: URL) =>
  /(^|\.)datacat\.run$/i.test(url.hostname) ||
  /(^|\.)janitorai\.com$/i.test(url.hostname) ||
  /(^|\.)janitor\.ai$/i.test(url.hostname);

export const characterId = (input: string) =>
  UUID_RE.exec(input)?.[0].toLowerCase() ?? null;

// Raw shape of a datacat lorebook script. `script` is the entry array as a JSON
// STRING, and it is empty for anything JanitorAI withheld.
type Script = {
  id?: string;
  type?: string;
  title?: string;
  script?: string | null;
  settings?: string | null;
  scriptDetailStatus?: number | null;
};

// Runs INSIDE the page, so the request is same-origin and carries whatever
// Cloudflare clearance the browser earned. Reaching this API any other way
// fails: no response carries an Access-Control-Allow-Origin, and the origin
// challenges datacenter IPs.
const FETCH_IN_PAGE = `(async (id) => {
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n))
    .reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  const auth = await fetch("/api/liberator/identify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceToken: "anon_" + rand(16) + "_" + rand(4) }),
  });
  if (!auth.ok) return { error: "identify " + auth.status };
  const { sessionToken } = await auth.json();
  const res = await fetch("/api/characters/" + id, {
    headers: { accept: "application/json", "x-session-token": sessionToken },
  });
  if (res.status === 404) return { error: "not_found" };
  if (!res.ok) return { error: "character " + res.status };
  const body = await res.json();
  const c = body.character;
  if (!c) return { error: "empty" };
  return {
    card: c.chara_card_v2_json,
    scripts: (c.scripts || []).map((s) => ({
      id: s.id, type: s.type, title: s.title,
      script: s.script, settings: s.settings,
      scriptDetailStatus: s.scriptDetailStatus,
    })),
  };
})`;

export type FetchResult = { card: UniformCard; retryIds: string[] };

export async function fetchCard(
  page: PageWithCursor,
  url: URL,
): Promise<FetchResult> {
  const id = characterId(url.href);
  if (!id) throw new Error("no character id in url");

  if (!page.url().startsWith("https://datacat.run")) {
    await page.goto("https://datacat.run/", {
      waitUntil: "load",
      timeout: 45000,
    });
  }

  const raw = (await page.evaluate(
    `${FETCH_IN_PAGE}(${JSON.stringify(id)})`,
  )) as {
    error?: string;
    card?: unknown;
    scripts?: Script[];
  };
  if (raw?.error) throw new Error(`datacat: ${raw.error}`);

  const card =
    typeof raw.card === "string"
      ? JSON.parse(raw.card)
      : (raw.card as Record<string, unknown>);
  if (!card) throw new Error("datacat: response carried no card");

  const lorebooks: UniformLorebook[] = [];
  const skipped: SkippedLorebook[] = [];
  // Ids worth asking JanitorAI for directly: datacat's copy of a 404 can be
  // stale, and a book published since its last scrape answers 200 there.
  const retryIds: string[] = [];

  for (const s of raw.scripts ?? []) {
    if (s.type !== "lorebook") continue;
    // Non-empty `script` is the only real test. JanitorAI sends an empty string
    // for both the withheld cases, and datacat records that faithfully.
    if (!s.script) {
      skipped.push({
        title: s.title || "Untitled",
        reason: s.scriptDetailStatus === 404 ? "not_found" : "private",
      });
      if (s.id) retryIds.push(s.id);
      continue;
    }
    const entries = toEntries(s.script);
    if (entries.length === 0) {
      skipped.push({ title: s.title || "Untitled", reason: "private" });
      continue;
    }
    let scanDepth: number | undefined;
    try {
      scanDepth = JSON.parse(s.settings || "{}")?.depth ?? undefined;
    } catch {}
    lorebooks.push({
      name: s.title || "Imported lorebook",
      scanDepth,
      entries,
    });
  }

  return {
    card: {
      source: "datacat",
      sourceUrl: url.href,
      card: card as UniformCard["card"],
      lorebooks,
      skipped,
    },
    retryIds,
  };
}
