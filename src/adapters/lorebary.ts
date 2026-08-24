import type { PageWithCursor } from "puppeteer-real-browser";
import type {
  ImportResult,
  UniformAsset,
  UniformEntry,
  UniformLorebook,
  UniformPersona,
} from "../types/uniform-card";
import { evaluateOn } from "../worker/page-tools";

// LoreBary publishes seven types and each has its own API namespace. Personas
// are the reason this adapter exists (everywhere else treats a persona as
// private account data: chub serves the caller's own, Backyard strips the field
// on publish), but they are one of seven rather than the whole site. A chub trap
// worth remembering, since it looks like a counterexample:
// search?namespace=personas returns 60k results that are actually presets,
// because an unknown namespace silently falls back.
//
// Bindery is deliberately absent: /api/bindery answers 401, so it is account
// data rather than published content.
const LOREBARY_HOSTS = /^(www\.)?lorebary\.com$/i;

// Codes are short hex, not uuids. Both URL shapes are accepted per type because
// the HTML routes sit behind Cloudflare and cannot be fetched to learn which
// one the site hands out; the code is what identifies the row either way.
const codeMatcher = (...segments: string[]) =>
  new RegExp(`/(?:${segments.join("|")})/([A-Z0-9]{5,12})`, "i");

const CODE_RE = codeMatcher("persona", "persona-marketplace");
const CHARACTER_RE = codeMatcher("character", "character-marketplace");
const LOREBOOK_RE = codeMatcher("lorebook", "lorebook-library");
const PLUGIN_RE = codeMatcher("plugin", "plugin-library");
const PROMPT_RE = codeMatcher("prompt", "prompt-library");
const SCENARIO_RE = codeMatcher("scenario", "scenario-library");

const onLorebary = (url: URL) => LOREBARY_HOSTS.test(url.hostname);
const matcher = (re: RegExp) => (url: URL) =>
  onLorebary(url) && re.test(url.pathname);

export const matchesLorebary = matcher(CODE_RE);
export const matchesLorebaryCharacter = matcher(CHARACTER_RE);
export const matchesLorebaryLorebook = matcher(LOREBOOK_RE);
export const matchesLorebaryPlugin = matcher(PLUGIN_RE);
export const matchesLorebaryPrompt = matcher(PROMPT_RE);
export const matchesLorebaryScenario = matcher(SCENARIO_RE);

export const personaCode = (input: string) =>
  CODE_RE.exec(input)?.[1]?.toUpperCase() ?? null;

const codeFrom = (url: URL, re: RegExp, label: string) => {
  const code = re.exec(url.pathname)?.[1]?.toUpperCase();
  if (!code) throw new Error(`lorebary: no ${label} code in url`);
  return code;
};

// Every non-persona type has a real detail endpoint, so one in-page fetch does
// what the persona path needs 40 pages of listing for. A 403 is the author
// having switched downloads off, which no VPN reroll can change, so it is
// reported as its own permanent error rather than a generic failure.
const DOWNLOAD = `(async (path) => {
  const r = await fetch(path, { headers: { accept: "application/json" } });
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("json")) return { error: "not_found" };
  const body = await r.json();
  if (r.status === 403) return { error: "forbidden" };
  if (!r.ok || body.success === false) return { error: "not_found" };
  return { body };
})`;

async function download<T>(
  page: PageWithCursor,
  path: string,
  label: string,
): Promise<T> {
  const out = await evaluateOn<{ error?: string; body?: T }>(
    page,
    "https://lorebary.com/",
    `${DOWNLOAD}(${JSON.stringify(path)})`,
  );
  if (out?.error === "forbidden") {
    throw new Error(`lorebary: downloads disabled for this ${label}`);
  }
  if (out?.error || !out?.body) {
    throw new Error(`lorebary: ${label} not found`);
  }
  return out.body;
}

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

// Their lorebook entries arrive as an object map keyed "1","2","3", not an
// array, and `disable` is the inverse of `enabled`. Everything else lines up
// with UniformEntry, so this is a rename rather than a conversion.
type LorebaryEntry = {
  key?: string[];
  keysecondary?: string[];
  content?: string;
  comment?: string;
  name?: string;
  constant?: boolean;
  selective?: boolean;
  disable?: boolean;
  order?: number;
  keyMatchMode?: string;
};

const mapEntries = (raw: unknown): UniformEntry[] => {
  if (!raw || typeof raw !== "object") return [];
  const rows = Array.isArray(raw) ? raw : Object.values(raw);
  const out: UniformEntry[] = [];
  rows.forEach((row, i) => {
    const e = row as LorebaryEntry;
    const keys = (e.key ?? []).filter(Boolean);
    if (!e.content) return;
    if (keys.length === 0 && !e.constant) return;
    out.push({
      keys,
      secondaryKeys: e.keysecondary?.length ? e.keysecondary : undefined,
      content: e.content,
      comment: e.comment || e.name || undefined,
      enabled: e.disable !== true,
      constant: !!e.constant,
      selective: !!e.selective,
      priority: typeof e.order === "number" ? e.order : 100,
      orderIndex: i,
      matchWholeWords: e.keyMatchMode === "whole",
    });
  });
  return out;
};

export async function fetchLorebaryLorebook(
  page: PageWithCursor,
  url: URL,
): Promise<ImportResult> {
  const code = codeFrom(url, LOREBOOK_RE, "lorebook");
  const body = await download<{
    name?: string;
    description?: string;
    entries?: unknown;
    extensions?: { world_info_depth?: number };
  }>(page, `/api/lorebook/download/${code}`, "lorebook");

  const entries = mapEntries(body.entries);
  if (entries.length === 0) {
    throw new Error("lorebary: lorebook has no importable entries");
  }
  return {
    kind: "lorebook",
    source: "lorebary",
    sourceUrl: url.href,
    lorebooks: [
      {
        name: body.name?.trim() || "Imported lorebook",
        scanDepth: body.extensions?.world_info_depth,
        entries,
      },
    ],
    skipped: [],
  };
}

// A LoreBary plugin is a lorebook entry carrying a trigger and an action, not a
// program: measured over 12 downloadable plugins, 12 used `entries` and 0 used
// `advancedCode`. The top-level triggerGroups/actions/logic are a legacy
// duplicate of what is already inside `entries` (their own migrated entries say
// so in `comment`), so reading the top level would import the same content
// twice.
type PluginAction = {
  type?: string;
  role?: string;
  pool?: string[];
  append?: boolean;
};

type PluginEntry = {
  uid?: number;
  name?: string;
  comment?: string;
  order?: number;
  triggerGroups?: {
    type?: string;
    chance?: number;
    keywords?: string[];
  }[];
  actions?: { default?: PluginAction[] };
};

const INJECTION_ROLES = new Set(["system", "user", "assistant"]);

function pluginEntry(e: PluginEntry, i: number): UniformEntry | null {
  const action = e.actions?.default?.find((a) => a.type === "add_message");
  const pool = (action?.pool ?? []).filter(Boolean);
  if (pool.length === 0) return null;

  const trigger = e.triggerGroups?.[0];
  const keys = (trigger?.keywords ?? []).filter(Boolean);
  const constant = (trigger?.type ?? "").toLowerCase() === "always";
  if (keys.length === 0 && !constant) return null;

  // A multi-string pool is a random pick per turn on LoreBary. `append` means
  // they were all meant to apply, so joining is faithful; otherwise only the
  // first is real content and the rest are alternates, recorded in the comment
  // rather than silently dropped or wrongly concatenated.
  const content = action?.append ? pool.join("\n\n") : pool[0];
  const alternates =
    !action?.append && pool.length > 1
      ? `${pool.length - 1} unused alternate(s) from the source pool`
      : null;
  const label = e.comment || e.name;

  const role = (action?.role ?? "").toLowerCase();
  const chance = trigger?.chance;

  return {
    keys,
    content,
    comment: [label, alternates].filter(Boolean).join(" | ") || undefined,
    enabled: true,
    constant,
    selective: false,
    priority: typeof e.order === "number" ? e.order : 100,
    orderIndex: i,
    matchWholeWords: false,
    ...(INJECTION_ROLES.has(role)
      ? { injectionRole: role as UniformEntry["injectionRole"] }
      : {}),
    ...(typeof chance === "number" && chance > 0 && chance < 100
      ? { chance }
      : {}),
  };
}

export async function fetchLorebaryPlugin(
  page: PageWithCursor,
  url: URL,
): Promise<ImportResult> {
  const code = codeFrom(url, PLUGIN_RE, "plugin");
  const body = await download<{
    name?: string;
    description?: string;
    entries?: unknown;
    variables?: unknown;
    switches?: unknown;
  }>(page, `/api/plugin/download/${code}`, "plugin");

  const rows = !body.entries
    ? []
    : Array.isArray(body.entries)
      ? body.entries
      : Object.values(body.entries as Record<string, unknown>);
  const entries = rows
    .map((row, i) => pluginEntry(row as PluginEntry, i))
    .filter((e): e is UniformEntry => e !== null);
  if (entries.length === 0) {
    throw new Error("lorebary: plugin has no importable entries");
  }

  // Named rather than silent. These gate entries inside LoreBary's own runtime,
  // so an entry that depended on them will fire more often here than it did
  // there, and the user is the only one who can judge whether that matters.
  const dropped: string[] = [];
  const has = (v: unknown) =>
    !!v && typeof v === "object" && Object.keys(v).length > 0;
  if (has(body.variables)) dropped.push("variables");
  if (has(body.switches)) dropped.push("switches");

  return {
    kind: "lorebook",
    source: "lorebary",
    sourceUrl: url.href,
    lorebooks: [
      {
        name: body.name?.trim() || "Imported plugin",
        entries,
      },
    ],
    skipped: dropped.map((title) => ({
      title: `${title} (not supported, entries may trigger more often)`,
      reason: "not_found" as const,
    })),
  };
}

// unorouter's PromptItem[] shape. Built here rather than shipped as raw modules
// for the client to assemble: this adapter is the only place that knows how a
// LoreBary block list orders, so emitting the finished template keeps the
// importer a row write instead of a per-source branch.
const promptTemplate = (...leading: string[]): string =>
  JSON.stringify([
    ...leading
      .filter(Boolean)
      .map((text) => ({ type: "plain", text, role: "system" })),
    { type: "slot", slot: "description" },
    { type: "slot", slot: "persona" },
    { type: "slot", slot: "lorebook" },
    { type: "chat", rangeStart: -1000, rangeEnd: "end" },
    { type: "slot", slot: "postHistory" },
    { type: "slot", slot: "prefill" },
  ]);

export async function fetchLorebaryPrompt(
  page: PageWithCursor,
  url: URL,
): Promise<ImportResult> {
  const code = codeFrom(url, PROMPT_RE, "prompt");
  const body = await download<{
    title?: string;
    modules?: { content?: string; isCore?: boolean }[];
  }>(page, `/api/prompt/download/${code}`, "prompt");

  // isCore is the block meant to lead; the rest keep their published order.
  const blocks = (body.modules ?? [])
    .filter((m) => m?.content?.trim())
    .sort((a, b) => Number(b.isCore === true) - Number(a.isCore === true))
    .map((m) => m.content!.trim());
  if (blocks.length === 0) {
    throw new Error("lorebary: prompt has no importable modules");
  }

  return {
    kind: "preset",
    source: "lorebary",
    sourceUrl: url.href,
    preset: {
      name: body.title?.trim() || "Imported prompt",
      promptTemplate: promptTemplate(...blocks),
    },
    lorebooks: [],
  };
}

export async function fetchLorebaryScenario(
  page: PageWithCursor,
  url: URL,
): Promise<ImportResult> {
  const code = codeFrom(url, SCENARIO_RE, "scenario");
  const body = await download<{
    name?: string;
    description?: string;
    content?: string;
    lorebooks?: { name?: string; entries?: unknown }[];
    meta?: {
      rules?: Record<string, string>;
      tone?: string;
      pov?: string;
    };
  }>(page, `/api/scenarios/download/${code}`, "scenario");

  // Their rules are a fixed set of named fields (world, characters, player,
  // narrative, goals, boundaries), all optional and routinely blank.
  const rules: Record<string, string> = {};
  for (const [k, v] of Object.entries(body.meta?.rules ?? {})) {
    if (typeof v === "string" && v.trim()) rules[k] = v.trim();
  }

  const content = body.content?.trim() ?? "";
  if (!content && Object.keys(rules).length === 0) {
    throw new Error("lorebary: scenario is empty");
  }

  const lorebooks: UniformLorebook[] = (body.lorebooks ?? [])
    .map((b) => ({
      name: b.name?.trim() || "Scenario lorebook",
      entries: mapEntries(b.entries),
    }))
    .filter((b) => b.entries.length > 0);

  // Their rules are separate named fields but read as one instruction block, so
  // they are labelled and joined rather than modelled: nothing downstream reads
  // "narrative" as distinct from "boundaries".
  const ruleText = Object.entries(rules)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  return {
    kind: "preset",
    source: "lorebary",
    sourceUrl: url.href,
    preset: {
      name: body.name?.trim() || "Imported scenario",
      promptTemplate: promptTemplate(content, ruleText),
    },
    lorebooks,
  };
}

// The card endpoint returns a complete V2 envelope, so it passes straight
// through. character_book is empty on every sampled row (LoreBary keeps
// lorebooks as separate entities), which is why no book is extracted here.
export async function fetchLorebaryCharacter(
  page: PageWithCursor,
  url: URL,
): Promise<ImportResult> {
  const code = codeFrom(url, CHARACTER_RE, "character");
  const body = await download<{
    spec?: string;
    spec_version?: string;
    data?: Record<string, unknown>;
  }>(page, `/api/character/download/${code}`, "character");

  if (!body.data || typeof body.data !== "object") {
    throw new Error("lorebary: character not found");
  }

  const avatar = await fetchCover(page, "character", code);

  return {
    kind: "character",
    source: "lorebary",
    sourceUrl: url.href,
    ...(avatar ? { avatar } : {}),
    card: {
      spec: body.spec || "chara_card_v2",
      spec_version: body.spec_version || "2.0",
      data: body.data,
    },
    lorebooks: [],
    skipped: [],
  };
}

// The list row's coverImage is null even when hasCoverImage is true, so the
// bytes only exist behind this endpoint. Best-effort: a card without a picture
// is worth importing, a failed import is not.
const READ_COVER = `(async (path) => {
  const r = await fetch(path);
  if (!r.ok) return null;
  const type = r.headers.get("content-type") || "";
  if (!type.startsWith("image/")) return null;
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length === 0) return null;
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return { mimeType: type.split(";")[0], base64: btoa(bin) };
})`;

async function fetchCover(
  page: PageWithCursor,
  type: string,
  code: string,
): Promise<UniformAsset | undefined> {
  try {
    const out = await evaluateOn<{ mimeType: string; base64: string } | null>(
      page,
      "https://lorebary.com/",
      `${READ_COVER}(${JSON.stringify(`/api/${type}/cover/${code}`)})`,
    );
    if (!out?.base64) return undefined;
    return {
      name: `${code}.${out.mimeType.split("/")[1] || "png"}`,
      mimeType: out.mimeType,
      base64: out.base64,
    };
  } catch {
    return undefined;
  }
}
