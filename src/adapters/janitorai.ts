import type { PageWithCursor } from "puppeteer-real-browser";
import type { UniformCard } from "../types/uniform-card";
import { evaluateOn } from "../worker/page-tools";

// datacat lists every lorebook attached to a character but stores `script: null`
// whenever its own scrape got a 404, and its scrape is not always current. Ask
// JanitorAI directly for those ids: /hampter/script/{id} needs no session, and a
// book the author has since published answers 200 here while datacat still has
// the stale failure recorded.
//
// This cannot recover genuinely private books. Verified in a logged-IN browser:
// a private id returns the same 404 with a session as without, so the ceiling is
// the author's setting, not authentication.

const FETCH_SCRIPTS_IN_PAGE = `(async (ids) => {
  const out = [];
  for (const id of ids) {
    try {
      const r = await fetch("/hampter/script/" + id, { headers: { accept: "application/json" } });
      if (!r.ok) { out.push({ id, status: r.status }); continue; }
      const j = await r.json();
      out.push({ id, status: 200, title: j.title, script: j.script, settings: j.settings });
    } catch (e) {
      out.push({ id, status: 0 });
    }
  }
  return out;
})`;

type Recovered = {
  id: string;
  status: number;
  title?: string;
  script?: string | null;
  settings?: string | null;
};

const SCRIPT_URL_RE =
  /\/(?:hampter\/)?scripts?\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;

// A lorebook shared on its own, rather than one attached to a character. The
// page URL is /scripts/{id} and the API path is /hampter/script/{id}, so the
// singular is optional: a link someone copies from the site is the plural one.
export const lorebookId = (input: string) =>
  SCRIPT_URL_RE.exec(input)?.[1]?.toLowerCase() ?? null;

export const matchesLorebook = (url: URL) =>
  /(^|\.)(janitorai\.com|janitor\.ai)$/i.test(url.hostname) &&
  lorebookId(url.pathname) !== null;

// Returns a card-shaped result carrying only lorebooks, so one job type and one
// response shape serve both imports.
export async function fetchLorebook(
  page: PageWithCursor,
  url: URL,
  toEntries: (raw: string) => UniformCard["lorebooks"][number]["entries"],
): Promise<UniformCard> {
  const id = lorebookId(url.pathname);
  if (!id) throw new Error("janitorai: no lorebook id in url");

  const books = await recoverLorebooks(page, [id], toEntries);
  if (books.length === 0) {
    // The author kept the code private, or deleted it. Both answer the same way
    // and neither is recoverable, so say which rather than returning nothing.
    throw new Error("janitorai: lorebook is private or no longer exists");
  }
  return {
    source: "janitorai",
    sourceUrl: url.href,
    card: { spec: "lorebook", data: {} },
    lorebooks: books,
    skipped: [],
  };
}

export async function recoverLorebooks(
  page: PageWithCursor,
  scriptIds: string[],
  toEntries: (raw: string) => UniformCard["lorebooks"][number]["entries"],
): Promise<UniformCard["lorebooks"]> {
  if (scriptIds.length === 0) return [];

  const rows = await evaluateOn<Recovered[]>(
    page,
    "https://janitorai.com/",
    `${FETCH_SCRIPTS_IN_PAGE}(${JSON.stringify(scriptIds)})`,
  );

  const out: UniformCard["lorebooks"] = [];
  for (const r of rows ?? []) {
    if (r.status !== 200 || !r.script) continue;
    const entries = toEntries(r.script);
    if (entries.length === 0) continue;
    let scanDepth: number | undefined;
    try {
      scanDepth = JSON.parse(r.settings || "{}")?.depth ?? undefined;
    } catch {}
    out.push({ name: r.title || "Imported lorebook", scanDepth, entries });
  }
  return out;
}
