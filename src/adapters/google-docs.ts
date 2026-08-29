import type { PageWithCursor } from "puppeteer-real-browser";
import type { ImportResult, UniformAsset } from "../types/uniform-card";
import { evaluateOn } from "../worker/page-tools";

// A reference document, which is one URL holding MANY characters: the Tokyo
// Revengers character book this was built against holds 29.
//
// Docs renders text to a canvas, so the DOM is empty, and /export answers 403
// whenever the owner has disabled download. /mobilebasic is neither: it serves
// the whole document as plain HTML and no restriction applies to it, which is
// the only reason any of this is readable.

const DOC_ID = /\/document\/d\/([A-Za-z0-9_-]{20,})/;

export const matchesGoogleDocs = (url: URL) =>
  /(^|\.)docs\.google\.com$/i.test(url.hostname) && DOC_ID.test(url.pathname);

export const documentId = (input: string) => DOC_ID.exec(input)?.[1] ?? null;

// Runs INSIDE the page so the request carries whatever session the browser has:
// a public document needs none, and a link-shared one is unreadable without it.
//
// Splitting is TYPOGRAPHIC, never textual. The document that motivated this has
// 477 flat <p> tags and no headings, classes or page breaks at all, so there is
// no structure to walk; what it does have is two font sizes, and that holds for
// any Docs file. Three rules:
//
//   1. body size is the most common size, anything larger is a heading
//   2. a heading opens an item, everything until the next heading is its body
//   3. a heading with NO body of its own is a label for what follows, so it
//      folds into the next item and donates its images
//
// Rule 3 is what makes this generic rather than a parser for one document: it
// resolves that book's "PAGE 14" markers without knowing the word PAGE, and it
// is why images attach at all, since they sit inside the label's paragraph.
const PARSE_IN_PAGE = `(async (id) => {
  const res = await fetch(
    "https://docs.google.com/document/d/" + id + "/mobilebasic",
    { credentials: "include" },
  );
  if (!res.ok) return { error: "mobilebasic " + res.status };
  const html = await res.text();
  const body = (html.match(/<body[^>]*>([\\s\\S]*)<\\/body>/i) || [, html])[1];

  // A sign-in interstitial is served with 200, so the status alone cannot tell
  // a private document from a readable one.
  if (/accounts\\.google\\.com\\/(ServiceLogin|signin)/.test(html)) {
    return { error: "not_public" };
  }

  const nodes = [];
  for (const m of body.matchAll(/<(p|h1|h2|h3|h4|li)([^>]*)>([\\s\\S]*?)<\\/\\1>/g)) {
    const inner = m[3];
    const images = [];
    for (const im of inner.matchAll(/<img[^>]+src="([^"]+)"/g)) {
      if (!/googlelogo|branding/.test(im[1])) images.push(im[1]);
    }
    const text = inner
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .trim();
    const size = Number((inner.match(/font-size:\\s*([\\d.]+)pt/i) || [])[1]) || null;
    if (text || images.length) nodes.push({ tag: m[1], text, size, images });
  }

  const counts = {};
  for (const n of nodes) if (n.size && n.text) counts[n.size] = (counts[n.size] || 0) + 1;
  const bodySize = Number(
    Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0],
  );
  const isHeading = (n) =>
    /^h[1-4]$/.test(n.tag) || (n.size && bodySize && n.size > bodySize);

  const raw = [];
  let cur = null;
  for (const n of nodes) {
    if (n.text && isHeading(n)) {
      cur = { title: n.text, lines: [], images: n.images.slice() };
      raw.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.images.push(...n.images);
    if (n.text) cur.lines.push(n.text);
  }

  // Rule 3, applied after the fact: a bodyless heading carries forward.
  const items = [];
  let carried = null;
  for (const it of raw) {
    if (!it.lines.length) {
      // Two markers in a row means the first one's item never came, so it is
      // dropped rather than kept as a title of its own.
      carried = it;
      continue;
    }
    if (carried) {
      it.images = carried.images.concat(it.images);
      carried = null;
    }
    items.push(it);
  }
  // A document with ONE font size yields no headings at all, so keep the whole
  // thing as a single item rather than reporting nothing found.
  if (items.length === 0 && nodes.length) {
    items.push({
      title: (document.title || "Document").replace(/ - Google Docs$/, ""),
      lines: nodes.filter((n) => n.text).map((n) => n.text),
      images: nodes.flatMap((n) => n.images),
    });
  }
  return { items };
})`;

// Assets are a second fetch each and only the portrait is worth carrying, so
// this takes the first image per item. Base64 because binary cannot cross
// page.evaluate, chunked because a spread of a megabyte-long array overflows.
const FETCH_IMAGE_IN_PAGE = `(async (src) => {
  try {
    const r = await fetch(src, { credentials: "include" });
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 8192) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
    }
    return JSON.stringify({
      mimeType: r.headers.get("content-type") || "image/png",
      base64: btoa(bin),
    });
  } catch (e) { return null; }
})`;

type ParsedItem = { title: string; lines: string[]; images: string[] };
type Parsed = { error?: string; items?: ParsedItem[] };

// "Height: 175cm" is a field; a paragraph of prose is not. Reference books are
// mostly the former, and keeping them apart is what lets the key-value lines
// become a personality block while the prose stays a description.
const FIELD = /^[A-Z][^:\n]{0,48}:\s*\S/;

export async function fetchGoogleDoc(
  page: PageWithCursor,
  url: URL,
): Promise<ImportResult[]> {
  const id = documentId(url.href);
  if (!id) throw new Error("google-docs: no document id in url");

  // The DOCUMENT, not the docs.google.com root: the root redirects a signed-out
  // browser to accounts.google.com, so navigating there never lands on the
  // origin and the job fails before it can read anything. A public document
  // serves fine without a session.
  const parsed = await evaluateOn<Parsed>(
    page,
    `https://docs.google.com/document/d/${id}/mobilebasic`,
    `${PARSE_IN_PAGE}(${JSON.stringify(id)})`,
  );
  if (parsed?.error === "not_public") {
    throw new Error("google-docs: document is not public");
  }
  if (parsed?.error) throw new Error(`google-docs: ${parsed.error}`);
  const items = parsed?.items ?? [];
  if (items.length === 0) throw new Error("google-docs: no importable content");

  const out: ImportResult[] = [];
  for (const item of items) {
    // A ranking table is a heading whose body is mostly numbered names
    // ("1. Pa-chin", "2. Draken"). It is a real section of the document and a
    // real heading, but importing one produces a card whose entire personality
    // is a leaderboard. Counting rather than requiring zero fields, because
    // these tables carry a "BEST3:" column header that reads as a field.
    const numbered = item.lines.filter((l) => /^\s*\d+\.\s/.test(l)).length;
    if (numbered >= 2 && numbered >= item.lines.length / 2) continue;

    let avatar: UniformAsset | undefined;
    if (item.images[0]) {
      const raw = await page.evaluate(
        `${FETCH_IMAGE_IN_PAGE}(${JSON.stringify(item.images[0])})`,
      );
      if (typeof raw === "string") {
        try {
          const img: unknown = JSON.parse(raw);
          if (
            img &&
            typeof img === "object" &&
            typeof (img as { base64?: unknown }).base64 === "string"
          ) {
            const { mimeType, base64 } = img as {
              mimeType: string;
              base64: string;
            };
            avatar = { name: "avatar", mimeType, base64 };
          }
        } catch {
          // an image is not worth failing the item over
        }
      }
    }

    const fields = item.lines.filter((l) => FIELD.test(l));
    const prose = item.lines.filter((l) => !FIELD.test(l));

    // A page marker titles an item whenever that character's name was written
    // body-sized, so no heading ever opened one and the marker above it is all
    // the item had. The name is then the first prose line: it cannot be among
    // the fields, because a name is not "Key: value", and it need not be the
    // first LINE, since this book puts the stat block above the name.
    const marker = /^[^a-z]*\d+\s*$|^page\b/i.test(item.title);
    const candidate = prose[0] ?? "";
    const named =
      marker &&
      candidate.length <= 48 &&
      !candidate.includes(".") &&
      candidate === candidate.toUpperCase();
    if (named) prose.shift();

    out.push({
      source: "google-docs",
      sourceUrl: url.href,
      avatar,
      card: {
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
          name: named ? candidate : item.title,
          description: prose.join("\n\n"),
          personality: fields.join("\n"),
          // A reference book has no greeting and no scenario. Leaving these
          // empty is the honest result: writing one would put words in the
          // character's mouth that the source never gave them, and the UI
          // flags a card that cannot open a roleplay yet.
          scenario: "",
          first_mes: "",
          mes_example: "",
          creator: "",
          character_version: "",
          system_prompt: "",
          post_history_instructions: "",
          alternate_greetings: [],
          tags: [],
          extensions: {},
        },
      },
      lorebooks: [],
      skipped: [],
    });
  }
  return out;
}
