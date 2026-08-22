import type { PageWithCursor } from "puppeteer-real-browser";
import type { ImportResult } from "../types/uniform-card";
import { evaluateOn } from "../worker/page-tools";

// Saucepan serves a companion's public profile without a session, but the
// description arrives as fragments rather than as text: each carries a key and
// an FNV-1a proof, roughly 40% of them are decoys, and the reading order is the
// key XOR'd with a per-card mask. The site reassembles them in the browser, so
// a naive join of `text` yields interleaved nonsense.
//
// Scope, measured: the greeting and the advanced prompt live behind
// /api/v1/companion/definition, which answers 401 without a session, and the
// lorebook entries behind /api/v1/lorebooks/{id}, which answers 404. Neither is
// reachable, so an import carries the description, the tags and the art.

const UUID_RE = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;

export const matchesSaucepan = (url: URL) =>
  /^(www\.)?saucepan\.ai$/i.test(url.hostname);

const companionId = (input: string) => UUID_RE.exec(input)?.[0] ?? null;

const FETCH_IN_PAGE = `(async (id) => {
  const res = await fetch("https://saucepan.ai/api/v2/companions/" + id, {
    headers: { accept: "application/json" },
  });
  if (res.status === 404) return { error: "not_found" };
  if (!res.ok) return { error: "companion " + res.status };
  const body = await res.json();
  const c = body && body.companion;
  if (!c) return { error: "empty" };

  const rotl = (v, n) => ((v << n) | (v >>> (32 - n))) >>> 0;
  const proofOf = (mask, order, text) => {
    const bytes = new TextEncoder().encode(text);
    let h = (2166136261 ^ rotl(mask, 7) ^ rotl(order, 13)) >>> 0;
    for (const b of bytes) {
      h ^= b;
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  };
  const assemble = (block) => {
    if (!block || !Array.isArray(block.fragments)) return "";
    const mask = Number(block.mask) || 0;
    return block.fragments
      .map((f) => ({ f, order: (Number(f.key) ^ mask) >>> 0 }))
      .filter(({ f, order }) => proofOf(mask, order, String(f.text)) === Number(f.proof))
      .sort((a, b) => a.order - b.order)
      .map(({ f }) => String(f.text))
      .join("");
  };

  let avatar = null;
  const imageId = c.image && c.image.id;
  if (imageId) {
    try {
      const r = await fetch("https://saucepan.ai/cdn/" + imageId + "/highres");
      if (r.ok) {
        const buf = new Uint8Array(await r.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 8192) {
          bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
        }
        avatar = {
          name: "avatar",
          mimeType: r.headers.get("content-type") || "image/webp",
          base64: btoa(bin),
        };
      }
    } catch (e) {}
  }

  return {
    name: String(c.display_name || c.name || "Saucepan companion"),
    creator: String(c.author_handle || ""),
    tagline: String(c.short_description || ""),
    description: assemble(c.full_description_fragments),
    tags: Array.isArray(c.tags) ? c.tags.map((t) => String(t && t.name ? t.name : t)) : [],
    lorebookCount: Number(c.lorebook_count) || 0,
    avatar,
  };
})`;

type Fetched = {
  error?: string;
  name?: string;
  creator?: string;
  tagline?: string;
  description?: string;
  tags?: string[];
  lorebookCount?: number;
  avatar?: { name: string; mimeType: string; base64: string } | null;
};

export async function fetchSaucepan(
  page: PageWithCursor,
  url: URL,
): Promise<ImportResult> {
  const id = companionId(url.href);
  if (!id) throw new Error("saucepan: no companion id in url");

  const out = await evaluateOn<Fetched>(
    page,
    "https://saucepan.ai/",
    `${FETCH_IN_PAGE}(${JSON.stringify(id)})`,
  );
  if (out?.error === "not_found") throw new Error("saucepan: companion not found");
  if (out?.error || !out?.name) {
    throw new Error(`saucepan: ${out?.error ?? "empty"}`);
  }
  if (!out.description) {
    throw new Error("saucepan: description did not reassemble");
  }

  // A book the author attached is counted on the profile but its entries are
  // not served, so name it as skipped rather than importing a card that looks
  // complete while its lore is silently missing.
  const skipped =
    (out.lorebookCount ?? 0) > 0
      ? [{ title: `${out.name} lorebook`, reason: "private" as const }]
      : [];

  return {
    source: "saucepan",
    sourceUrl: url.href,
    card: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: out.name,
        description: out.description,
        personality: "",
        scenario: "",
        first_mes: "",
        mes_example: "",
        creator: out.creator ?? "",
        creator_notes: out.tagline ?? "",
        tags: out.tags ?? [],
        character_version: "",
        system_prompt: "",
        post_history_instructions: "",
        alternate_greetings: [],
        extensions: {},
      },
    },
    avatar: out.avatar ?? undefined,
    lorebooks: [],
    skipped,
  };
}
