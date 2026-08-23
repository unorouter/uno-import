import type { PageWithCursor } from "puppeteer-real-browser";
import type { ImportResult, UniformLorebook } from "../types/uniform-card";
import { evaluateOn } from "../worker/page-tools";

// RisuRealm, fetched as JSON rather than as a PNG. The PNG carries the card and
// nothing else, while the same item served as json-v3 also carries its
// character_book, its assets, and the RisuAI extensions block that holds custom
// scripts and trigger scripts. One card measured 6415 chars of description, 1
// lorebook entry and 12 assets, all of which the PNG path dropped.
//
// There is no module to fetch, despite the format existing: RisuRealm's own
// "Module & Lorebook" tab reports 0 items while Character and Preset report 60
// each. Presets are not downloadable anonymously either, answering 403 "This
// card is not allowed to be downloaded in this format. type is 30 -1", so the
// item's numeric type gates which format it will serve.

const UUID_RE = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;
// Some ids are 64-char hashes rather than uuids.
const HASH_RE = /\/character\/([a-f0-9]{32,})/i;

export const matchesRisu = (url: URL) =>
  /^realm\.risuai\.net$/i.test(url.hostname);

const characterId = (input: string) =>
  UUID_RE.exec(input)?.[0].toLowerCase() ??
  HASH_RE.exec(input)?.[1]?.toLowerCase() ??
  null;

// Assets are content-addressed and served from a different host, so each one is
// a second fetch. Capped: a card with dozens of emotion sprites would otherwise
// turn one import into a long download, and only the icon is needed to show it.
const MAX_ASSETS = 6;

const FETCH_IN_PAGE = `(async (id, maxAssets) => {
  const res = await fetch(
    "https://realm.risuai.net/api/v1/download/json-v3/" + id + "?non_commercial=true",
    { headers: { accept: "application/json" } },
  );
  if (!res.ok) return { error: "download " + res.status };
  const card = await res.json();
  const data = card?.data || {};

  const out = [];
  const list = Array.isArray(data.assets) ? data.assets.slice(0, maxAssets) : [];
  for (const a of list) {
    const uri = String(a?.uri || "");
    // risustored: is a content hash, not a URL; the bytes live on the resource
    // host under /rs/<hash>.
    const src = uri.startsWith("risustored:")
      ? "https://sv.risuai.xyz/rs/" + uri.slice("risustored:".length)
      : /^https?:/.test(uri) ? uri : null;
    if (!src) continue;
    try {
      const r = await fetch(src);
      if (!r.ok) continue;
      const buf = new Uint8Array(await r.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 8192) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
      }
      out.push({
        name: String(a?.name || "asset"),
        mimeType: r.headers.get("content-type") || "image/png",
        base64: btoa(bin),
      });
    } catch (e) {}
  }
  return { card, assets: out };
})`;

type Fetched = {
  error?: string;
  card?: {
    spec?: string;
    data?: {
      name?: string;
      character_book?: { name?: string; entries?: unknown[] };
      extensions?: { risuai?: Record<string, unknown> };
    };
  };
  assets?: Array<{ name: string; mimeType: string; base64: string }>;
};

export async function fetchRisu(
  page: PageWithCursor,
  url: URL,
  toEntries: (raw: string) => UniformLorebook["entries"],
): Promise<ImportResult> {
  const id = characterId(url.href);
  if (!id) throw new Error("risu: no character id in url");

  const out = await evaluateOn<Fetched>(
    page,
    "https://realm.risuai.net/",
    `${FETCH_IN_PAGE}(${JSON.stringify(id)}, ${MAX_ASSETS})`,
  );
  if (out?.error || !out?.card)
    throw new Error(`risu: ${out?.error ?? "empty"}`);

  const data = out.card.data ?? {};
  const lorebooks: UniformLorebook[] = [];
  const book = data.character_book;
  if (book?.entries?.length) {
    const entries = toEntries(JSON.stringify(book.entries));
    if (entries.length > 0) {
      lorebooks.push({
        name: book.name || `${data.name ?? "risu"} lorebook`,
        entries,
      });
    }
  }

  const risuai = data.extensions?.risuai ?? {};
  // The icon asset is the card art; the rest are emotion sprites that belong
  // in the character's asset list rather than as its avatar.
  const assets = out.assets ?? [];
  const icon = assets.find((a) => /^icon/i.test(a.name)) ?? assets[0];
  return {
    kind: "rich-character",
    avatar: icon,
    source: "risu",
    sourceUrl: url.href,
    card: out.card as { spec: string; data: Record<string, unknown> },
    lorebooks,
    // Passed through untouched: unorouter stores both on a character and has
    // parsers for them already.
    regexScripts: risuai.customScripts,
    triggers: risuai.triggerscript,
    assets: out.assets ?? [],
  };
}
