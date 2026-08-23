import type { PageWithCursor } from "puppeteer-real-browser";
import type {
  SkippedLorebook,
  UniformCard,
  UniformLorebook,
} from "../types/uniform-card";
import { toEntries } from "./entries";
import { evaluateOn } from "../worker/page-tools";

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
  const avatarUrl = String(c.avatar || "");
  let avatar = null;
  if (avatarUrl) {
    const src = /^https?:/.test(avatarUrl)
      ? avatarUrl
      : "https://ella.janitorai.com/bot-avatars/" + avatarUrl;
    try {
      const r = await fetch(src);
      if (r.ok) {
        const buf = new Uint8Array(await r.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 8192) {
          bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
        }
        avatar = {
          name: "avatar",
          mimeType: r.headers.get("content-type") || "image/webp",
          base64: btoa(bin),
        };
      }
    } catch (e) {}
  }
  return {
    avatar,
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

  // /fresh rather than /, which 302s there: the redirect tears down the
  // execution context underneath page.evaluate and the call dies with
  // "Execution context was destroyed" even though the page loaded fine.
  const raw = await evaluateOn<{
    error?: string;
    card?: unknown;
    scripts?: Script[];
    avatar?: { name: string; mimeType: string; base64: string } | null;
  }>(
    page,
    "https://datacat.run/fresh",
    `${FETCH_IN_PAGE}(${JSON.stringify(id)})`,
  );
  // Report WHERE the failure happened. A 404 from identify means the evaluate
  // ran somewhere other than datacat's origin, which is a different bug from
  // datacat rejecting us, and the two are indistinguishable without this.
  if (raw?.error) throw new Error(`datacat: ${raw.error} (at ${page.url()})`);

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
      avatar: raw.avatar ?? undefined,
      lorebooks,
      skipped,
    },
    retryIds,
  };
}
