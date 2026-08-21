import type { PageWithCursor } from "puppeteer-real-browser";
import type { ImportResult, UniformPersona } from "../types/uniform-card";
import { evaluateOn } from "../worker/page-tools";

// The only site found that publishes PERSONAS. Everywhere else treats a persona
// as private account data: chub serves the caller's own, and Backyard strips the
// field on publish. A chub trap worth remembering, since it looks like a
// counterexample: search?namespace=personas returns 60k results that are
// actually presets, because an unknown namespace silently falls back.
const LOREBARY_HOSTS = /^(www\.)?lorebary\.com$/i;

// Codes are short hex, not uuids.
const CODE_RE = /\/persona\/([A-Z0-9]{6,12})/i;

export const matchesLorebary = (url: URL) =>
  LOREBARY_HOSTS.test(url.hostname) && CODE_RE.test(url.pathname);

export const personaCode = (input: string) =>
  CODE_RE.exec(input)?.[1]?.toUpperCase() ?? null;

// There is no single-persona endpoint: /api/personas/{code} returns the SPA
// shell, as does every other unknown path, so a 200 there means nothing. The
// list is the only real endpoint, and it does support ?search= and ?page=.
// Search first because it is one request; fall back to paging because a name is
// not in the URL, so search can only be tried once a page has been read.
const FIND_IN_PAGE = `(async (code) => {
  const read = async (qs) => {
    const r = await fetch("/api/personas" + qs, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("json")) return null;
    return await r.json();
  };

  let page = 1;
  for (;;) {
    const data = await read(page === 1 ? "" : "?page=" + page);
    if (!data || !Array.isArray(data.personas)) return { error: "list unavailable" };
    const hit = data.personas.find((p) => String(p.code).toUpperCase() === code);
    if (hit) return { persona: hit };
    if (!data.hasMore || page >= (data.totalPages || 1)) return { error: "not_found" };
    page++;
    if (page > 40) return { error: "not_found" };
  }
})`;

type Row = {
  code?: string;
  name?: string;
  description?: string;
  archetype?: string;
  gender?: string;
  pronouns?: string;
  age?: string | number;
  traits?: unknown;
};

// Their description is HTML; the persona field is plain text everywhere else.
const stripHtml = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export async function fetchLorebaryPersona(
  page: PageWithCursor,
  url: URL,
): Promise<ImportResult> {
  const code = personaCode(url.pathname);
  if (!code) throw new Error("lorebary: no persona code in url");

  const out = await evaluateOn<{ error?: string; persona?: Row }>(
    page,
    "https://lorebary.com/",
    `${FIND_IN_PAGE}(${JSON.stringify(code)})`,
  );
  if (out?.error === "not_found" || !out?.persona) {
    throw new Error("lorebary: persona not found");
  }

  const row = out.persona;
  const attributes: Record<string, string> = {};
  for (const key of ["archetype", "gender", "pronouns", "age"] as const) {
    const v = row[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      attributes[key] = String(v);
    }
  }
  if (Array.isArray(row.traits) && row.traits.length > 0) {
    attributes.traits = row.traits.map(String).join(", ");
  }

  const persona: UniformPersona = {
    name: row.name?.trim() || "Imported persona",
    description: stripHtml(row.description ?? ""),
    attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
  };

  return {
    kind: "persona",
    source: "lorebary",
    sourceUrl: url.href,
    personas: [persona],
  };
}
