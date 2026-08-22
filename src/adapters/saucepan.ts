import type { ImportResult, UniformAsset } from "../types/uniform-card";

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
// /api/v1/companion/definition, which answers 401 without a session, and the
// lorebook entries behind /api/v1/lorebooks/{id}, which answers 404. Neither is
// reachable, so an import carries the description, the tags and the art.

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

  // A book the author attached is counted on the profile but its entries are
  // not served, so name it as skipped rather than importing a card that looks
  // complete while its lore is silently missing.
  const skipped =
    Number(c.lorebook_count) > 0
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
    lorebooks: [],
    skipped,
  };
}
