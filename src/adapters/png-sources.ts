import type { PageWithCursor } from "puppeteer-real-browser";
import type { UniformCard } from "../types/uniform-card";
import { gotoOrigin } from "../worker/page-tools";

// chub hands over a v2 card as a PNG with the JSON in a tEXt chunk rather than
// as an API response. Fetched through the browser like every other source: its
// API challenges datacenter IPs even though its CDN does not.

const UUID_RE = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;

const CHUB_HOSTS = /^(www\.)?(chub\.ai|characterhub\.org)$/i;

export const matchesChub = (url: URL) => CHUB_HOSTS.test(url.hostname);

// Read the PNG in the page and hand back base64: transferring bytes out of
// evaluate() any other way means a JSON array of 800k numbers.
const FETCH_PNG_IN_PAGE = `(async (src) => {
  const res = await fetch(src);
  if (!res.ok) return { error: "png " + res.status };
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 8192) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
  }
  return { b64: btoa(bin) };
})`;

// The card JSON lives in a tEXt chunk keyed "chara" (v2) or "ccv3" (v3), base64
// encoded inside the PNG.
function cardFromPng(png: Buffer): Record<string, unknown> {
  const latin = png.toString("latin1");
  for (const key of ["ccv3", "chara"]) {
    const at = latin.indexOf(key + "\0");
    if (at < 0) continue;
    let end = at + key.length + 1;
    while (end < latin.length && /[A-Za-z0-9+/=]/.test(latin[end]!)) end++;
    const slice = latin.slice(at + key.length + 1, end);
    try {
      return JSON.parse(Buffer.from(slice, "base64").toString("utf8"));
    } catch {}
  }
  throw new Error("png carries no character card");
}

async function fetchPngCard(
  page: PageWithCursor,
  origin: string,
  pngUrl: string,
  source: string,
  sourceUrl: string,
): Promise<UniformCard> {
  await gotoOrigin(page, origin);
  const out = (await page.evaluate(
    `${FETCH_PNG_IN_PAGE}(${JSON.stringify(pngUrl)})`,
  )) as { error?: string; b64?: string };
  if (out?.error || !out?.b64) throw new Error(`${source}: ${out?.error ?? "empty"}`);

  const card = cardFromPng(Buffer.from(out.b64, "base64"));
  return {
    source,
    sourceUrl,
    card: card as UniformCard["card"],
    // The PNG we just parsed IS the card art, so keep it rather than making
    // the client fetch an image we already have in hand.
    avatar: { name: "avatar", mimeType: "image/png", base64: out.b64 },
    // Neither source exposes lorebooks separately; anything attached rides
    // inside the card's own character_book.
    lorebooks: [],
    skipped: [],
  };
}

// chub keeps the lorebook out of the PNG and serves it from its API instead, so
// a card fetched only from the CDN silently arrives with none. One entry it
// publishes ran to 350 entries.
const FETCH_CHUB_LORE_IN_PAGE = `(async (path) => {
  try {
    const r = await fetch("https://api.chub.ai/api/characters/" + path + "?full=true", {
      headers: { accept: "application/json" },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const d = j?.node?.definition || {};
    return d.embedded_lorebook || d.character_book || null;
  } catch (e) { return null; }
})`;

export async function fetchChub(
  page: PageWithCursor,
  url: URL,
  toEntries: (raw: string) => UniformCard["lorebooks"][number]["entries"],
): Promise<UniformCard> {
  const parts = url.pathname.split("/").filter(Boolean);
  const at = parts.indexOf("characters");
  const author = at >= 0 ? parts[at + 1] : undefined;
  const slug = at >= 0 ? parts[at + 2] : undefined;
  if (!author || !slug) throw new Error("chub: no author/slug in url");

  const card = await fetchPngCard(
    page,
    "https://chub.ai/",
    `https://avatars.charhub.io/avatars/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/chara_card_v2.png`,
    "chub",
    url.href,
  );

  const book = (await page.evaluate(
    `${FETCH_CHUB_LORE_IN_PAGE}(${JSON.stringify(`${author}/${slug}`)})`,
  )) as { name?: string; entries?: unknown[] } | null;

  if (book?.entries?.length) {
    // Already CCv2 shaped, so the JanitorAI parser reads it unchanged.
    const entries = toEntries(JSON.stringify(book.entries));
    if (entries.length > 0) {
      card.lorebooks.push({ name: book.name || `${slug} lorebook`, entries });
    }
  }
  return card;
}
