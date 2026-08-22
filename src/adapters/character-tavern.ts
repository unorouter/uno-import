import type { ImportResult, UniformAsset } from "../types/uniform-card";

// Character Tavern serves a card's full definition to a logged-out caller and
// does not challenge the datacenter IP, so this fetches directly rather than
// through the browser.
//
// Its lorebooks are NOT reachable: the card carries a `lorebookId`, but the
// site's own "Download Card + Lorebook" button issues no request at all while
// signed out, and every lorebook route answers the SPA shell. A card that
// declares one therefore reports it as skipped rather than importing silently
// incomplete.

const TIMEOUT_MS = 20_000;

export const matchesCharacterTavern = (url: URL) =>
  /^(www\.)?character-tavern\.com$/i.test(url.hostname);

// /character/{author}/{slug}
function pathOf(url: URL): { author: string; slug: string } | null {
  const parts = url.pathname.split("/").filter(Boolean);
  const at = parts.indexOf("character");
  const author = at >= 0 ? parts[at + 1] : parts[0];
  const slug = at >= 0 ? parts[at + 2] : parts[1];
  if (!author || !slug) return null;
  return { author, slug };
}

type Card = {
  name?: string;
  inChatName?: string;
  author?: string;
  tagline?: string;
  description?: string;
  lorebookId?: number | null;
  definition_character_description?: string | null;
  definition_personality?: string | null;
  definition_scenario?: string | null;
  definition_first_message?: string | null;
  definition_example_messages?: string | null;
  definition_system_prompt?: string | null;
  definition_post_history_prompt?: string | null;
  isNSFW?: boolean;
};

export async function fetchCharacterTavern(url: URL): Promise<ImportResult> {
  const path = pathOf(url);
  if (!path) throw new Error("character-tavern: no author/slug in url");

  const res = await fetch(
    `https://character-tavern.com/api/character/${encodeURIComponent(path.author)}/${encodeURIComponent(path.slug)}`,
    {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (res.status === 404) throw new Error("character-tavern: card not found");
  if (!res.ok) throw new Error(`character-tavern: card ${res.status}`);

  const body = (await res.json()) as { card?: Card };
  const card = body?.card;
  const name = String(card?.name ?? "").trim();
  if (!card || !name) throw new Error("character-tavern: empty response");

  // The card art is the page image, served from their CDN under the same path.
  let avatar: UniformAsset | undefined;
  try {
    const img = await fetch(
      `https://ct-cards.storage.character-tavern.com/${path.author}/${path.slug}.png`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (img.ok) {
      avatar = {
        name: "avatar",
        mimeType: img.headers.get("content-type") || "image/png",
        base64: Buffer.from(await img.arrayBuffer()).toString("base64"),
      };
    }
  } catch {}

  return {
    source: "character-tavern",
    sourceUrl: url.href,
    card: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name,
        description: String(card.definition_character_description ?? card.description ?? ""),
        personality: String(card.definition_personality ?? ""),
        scenario: String(card.definition_scenario ?? ""),
        first_mes: String(card.definition_first_message ?? ""),
        mes_example: String(card.definition_example_messages ?? ""),
        system_prompt: String(card.definition_system_prompt ?? ""),
        post_history_instructions: String(card.definition_post_history_prompt ?? ""),
        creator: String(card.author ?? path.author),
        creator_notes: String(card.tagline ?? ""),
        alternate_greetings: [],
        tags: [],
        character_version: "",
        extensions: {},
      },
    },
    avatar,
    lorebooks: [],
    skipped: card.lorebookId
      ? [{ title: `${name} lorebook`, reason: "private" as const }]
      : [],
  };
}
