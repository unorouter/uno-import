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
