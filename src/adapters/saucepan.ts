import type {
  ImportResult,
  UniformAsset,
  UniformEntry,
  UniformLorebook,
} from "../types/uniform-card";
import { hasSaucepanAuth, withSaucepanAuth } from "./saucepan-auth";

// Saucepan serves a companion's public profile without a session, and unlike
// every other source here it does not challenge the datacenter IP, so this one
// fetches directly rather than through the browser. Routing it through the page
// would in fact FAIL: saucepan.ai/ redirects to /home and boots a heavy SPA, so
// the origin check in gotoOrigin rerolls the exit forever on a site that was
// answering plain requests the whole time.
//
// The description arrives as fragments rather than as text: each carries a key
// and an FNV-1a proof, roughly 40% of them are decoys, and the reading order is
// the key XOR'd with a per-card mask. The site reassembles them in the browser,
// so a naive join of `text` yields interleaved nonsense.
//
// Scope, measured: the greeting and the advanced prompt live behind
// /api/v1/companion/definition, which answers 401 without a session and is not
// fetched. Lorebook entries answer 404 to a logged-out caller, so they come
// through a signed-in fetch when credentials are configured and are reported as
// skipped when they are not.

const UUID_RE = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;

export const matchesSaucepan = (url: URL) =>
  /^(www\.)?saucepan\.ai$/i.test(url.hostname);

const companionId = (input: string) => UUID_RE.exec(input)?.[0] ?? null;

type Fragment = { text: string; key: number; proof: number };
type FragmentBlock = { mask: number; fragments: Fragment[] };

const rotl = (v: number, n: number) => ((v << n) | (v >>> (32 - n))) >>> 0;

// FNV-1a seeded with the mask and the fragment's decoded order, exactly as the
// site's own client computes it. A fragment whose proof does not match is a
// decoy and is dropped.
function proofOf(mask: number, order: number, text: string): number {
  const bytes = new TextEncoder().encode(text);
  let h = (2166136261 ^ rotl(mask, 7) ^ rotl(order, 13)) >>> 0;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function assemble(block: FragmentBlock | undefined): string {
  if (!block || !Array.isArray(block.fragments)) return "";
  const mask = Number(block.mask) || 0;
  return block.fragments
    .map((f) => ({ f, order: (Number(f.key) ^ mask) >>> 0 }))
    .filter(({ f, order }) => proofOf(mask, order, String(f.text)) === Number(f.proof))
    .sort((a, b) => a.order - b.order)
    .map(({ f }) => String(f.text))
    .join("");
}

type Companion = {
  name?: string;
  display_name?: string;
  author_handle?: string;
  short_description?: string;
  full_description_fragments?: FragmentBlock;
  tags?: Array<string | { name?: string }>;
  lorebook_count?: number;
  image?: { id?: string };
};

const TIMEOUT_MS = 20_000;

// A Saucepan lorebook is a handful of long chapters rather than a list of
// entries, and the keywords are written INTO the prose: every section opens with
// a "> Heading" line followed by "-# keys: a, b, c". Splitting on those headings
// is what turns 2 chapters into the 10 entries the author actually wrote, and
// without it the whole chapter would land as one always-on block.
const SECTION_RE = /^>\s*(.+)$/gm;
const KEYS_RE = /^-#\s*keys:\s*(.+)$/im;

function chapterToEntries(title: string, text: string, from: number): UniformEntry[] {
  const bounds: Array<{ heading: string; start: number; end: number }> = [];
  for (const m of text.matchAll(SECTION_RE)) {
    const start = m.index ?? 0;
    if (bounds.length > 0) bounds[bounds.length - 1]!.end = start;
    bounds.push({ heading: m[1]!.trim(), start, end: text.length });
  }
  // No headings: keep the chapter whole rather than dropping it.
  if (bounds.length === 0) {
    return [
      {
        keys: [title],
        content: text.trim(),
        comment: title,
        enabled: true,
        constant: false,
        selective: false,
        priority: 100,
        orderIndex: from,
        matchWholeWords: false,
      },
    ];
  }

  return bounds.flatMap((b, i) => {
    const body = text.slice(b.start, b.end);
    const keyLine = KEYS_RE.exec(body)?.[1] ?? "";
    const keys = keyLine
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    const content = body.replace(KEYS_RE, "").trim();
    if (!content) return [];
    return [
      {
        // A section with no keys line would never fire on a keyword, so it falls
        // back to its own heading.
        keys: keys.length > 0 ? keys : [b.heading],
        content,
        comment: `${title}: ${b.heading}`,
        enabled: true,
        constant: false,
        selective: false,
        priority: 100,
        orderIndex: from + i,
        matchWholeWords: false,
      },
    ];
  });
}

type LorebookRef = { id?: string; name?: string };
type LorebookDetail = { name?: string; content?: Array<{ title?: string; text?: string }> };

// Entries are served only to a signed-in caller, so this runs solely when
// credentials are configured; without them the books stay reported as skipped.
async function fetchLorebooks(companionId: string): Promise<UniformLorebook[]> {
  const list = await withSaucepanAuth(
    (token) =>
      fetch(`https://saucepan.ai/api/v2/companions/${companionId}/lorebooks`, {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    async (res) => {
      if (!res.ok) return [] as LorebookRef[];
      const body = (await res.json()) as { lorebooks?: LorebookRef[] };
      return body?.lorebooks ?? [];
    },
  );

  const books: UniformLorebook[] = [];
  for (const ref of list) {
    if (!ref?.id) continue;
    const detail = await withSaucepanAuth(
      (token) =>
        fetch(`https://saucepan.ai/api/v1/lorebooks/${ref.id}`, {
          headers: { accept: "application/json", authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }),
      async (res) => (res.ok ? ((await res.json()) as LorebookDetail) : null),
    );
    if (!detail) continue;

    const entries: UniformEntry[] = [];
    for (const chapter of detail.content ?? []) {
      entries.push(
        ...chapterToEntries(
          String(chapter?.title ?? "").trim() || "Lore",
          String(chapter?.text ?? ""),
          entries.length,
        ),
      );
    }
    if (entries.length > 0) {
      books.push({ name: detail.name || ref.name || "Saucepan lorebook", entries });
    }
  }
  return books;
}

export async function fetchSaucepan(url: URL): Promise<ImportResult> {
  const id = companionId(url.href);
  if (!id) throw new Error("saucepan: no companion id in url");

  const res = await fetch(`https://saucepan.ai/api/v2/companions/${id}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) throw new Error("saucepan: companion not found");
  if (!res.ok) throw new Error(`saucepan: companion ${res.status}`);

  const body = (await res.json()) as { companion?: Companion };
  const c = body?.companion;
  if (!c) throw new Error("saucepan: empty response");

  const description = assemble(c.full_description_fragments);
  if (!description) throw new Error("saucepan: description did not reassemble");

  const name = String(c.display_name || c.name || "Saucepan companion");

  let avatar: UniformAsset | undefined;
  const imageId = c.image?.id;
  if (imageId) {
    try {
      const r = await fetch(`https://saucepan.ai/cdn/${imageId}/highres`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        avatar = {
          name: "avatar",
          mimeType: r.headers.get("content-type") || "image/webp",
          base64: buf.toString("base64"),
        };
      }
    } catch {}
  }

  // Entries are withheld from a logged-out caller, so an attached book either
  // comes through the signed-in fetch or is named as skipped: a card that looks
  // complete while its lore is silently missing is the worse outcome.
  let lorebooks: UniformLorebook[] = [];
  if (Number(c.lorebook_count) > 0 && hasSaucepanAuth()) {
    try {
      lorebooks = await fetchLorebooks(id);
    } catch {
      lorebooks = [];
    }
  }
  const skipped =
    Number(c.lorebook_count) > 0 && lorebooks.length === 0
      ? [{ title: `${name} lorebook`, reason: "private" as const }]
      : [];

  return {
    source: "saucepan",
    sourceUrl: url.href,
    card: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name,
        description,
        personality: "",
        scenario: "",
        first_mes: "",
        mes_example: "",
        creator: String(c.author_handle || ""),
        creator_notes: String(c.short_description || ""),
        tags: (c.tags ?? []).map((t) => (typeof t === "string" ? t : String(t?.name ?? ""))),
        character_version: "",
        system_prompt: "",
        post_history_instructions: "",
        alternate_greetings: [],
        extensions: {},
      },
    },
    avatar,
    lorebooks,
    skipped,
  };
}
