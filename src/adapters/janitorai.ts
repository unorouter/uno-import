import type { PageWithCursor } from "puppeteer-real-browser";
import type { ImportResult, UniformCard } from "../types/uniform-card";
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
      out.push({ id, status: 200, title: j.title, script: j.script, settings: j.settings, type: j.type });
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
  // "lorebook" is a JSON array of entries. "advanced" is a JavaScript program
  // that builds its entries at chat time, so there is nothing to parse.
  type?: string;
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
// response shape serve both imports. An "advanced" script comes back as a
// plugin instead, since its entries only exist once the code has run.
export async function fetchLorebook(
  page: PageWithCursor,
  url: URL,
  toEntries: (raw: string) => UniformCard["lorebooks"][number]["entries"],
): Promise<ImportResult> {
  const id = lorebookId(url.pathname);
  if (!id) throw new Error("janitorai: no lorebook id in url");

  const rows = await fetchScripts(page, [id]);
  const row = rows[0];

  if (row && row.status !== 200) {
    throw new Error("janitorai: lorebook is private or no longer exists");
  }
  if (row?.status === 200 && row.type && row.type !== "lorebook") {
    if (!row.script) {
      throw new Error("janitorai: script is empty");
    }
    return {
      kind: "plugin",
      source: "janitorai",
      sourceUrl: url.href,
      plugin: { name: row.title || "Imported script", script: row.script },
    };
  }

  const books = toBooks(rows, toEntries);
  if (books.length === 0) {
    throw new Error("janitorai: lorebook has no importable entries");
  }
  return {
    source: "janitorai",
    sourceUrl: url.href,
    card: { spec: "lorebook", data: {} },
    lorebooks: books,
    skipped: [],
  };
}

async function fetchScripts(
  page: PageWithCursor,
  scriptIds: string[],
): Promise<Recovered[]> {
  if (scriptIds.length === 0) return [];
  return (
    (await evaluateOn<Recovered[]>(
      page,
      "https://janitorai.com/",
      `${FETCH_SCRIPTS_IN_PAGE}(${JSON.stringify(scriptIds)})`,
    )) ?? []
  );
}

export async function recoverLorebooks(
  page: PageWithCursor,
  scriptIds: string[],
  toEntries: (raw: string) => UniformCard["lorebooks"][number]["entries"],
): Promise<UniformCard["lorebooks"]> {
  return toBooks(await fetchScripts(page, scriptIds), toEntries);
}

function toBooks(
  rows: Recovered[],
  toEntries: (raw: string) => UniformCard["lorebooks"][number]["entries"],
): UniformCard["lorebooks"] {
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
