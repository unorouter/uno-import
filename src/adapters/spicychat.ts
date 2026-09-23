import type {
  ImportResult,
  SkippedLorebook,
  UniformAsset,
  UniformEntry,
  UniformLorebook,
} from "../types/uniform-card";

// The API serves any caller that names the app and sends a guest id, which the
// site itself mints as a random uuid, so this fetches directly.
//
// Most creators hide the definition (164 of the 250 most played bots on
// 2026-09-24), and such a character arrives with only its name, greeting and
// picture. Lorebook entries are readable only for public books, through the
// site's search index, since /lorebooks/{id} answers 403 to a guest.

const TIMEOUT_MS = 20_000;
const API = "https://prod.nd-api.com";
const SEARCH = "https://ts-lb.nd-api.com/multi_search";
const PAGE = 250;

const UUID_RE = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;

export const matchesSpicychat = (url: URL) =>
  /^(www\.)?spicychat\.ai$/i.test(url.hostname);

export const matchesSpicychatLorebook = (url: URL) =>
  matchesSpicychat(url) && /^\/lorebooks?\//i.test(url.pathname);

const apiHeaders = () => ({
  accept: "application/json",
  "x-app-id": "spicychat",
  "x-guest-userid": crypto.randomUUID(),
});

type Character = {
  name?: string;
  title?: string;
  greeting?: string;
  persona?: string;
  scenario?: string;
  dialogue?: string;
  creator_username?: string;
  avatar_url?: string;
  tags?: unknown[];
  lorebooks?: { id?: string; name?: string; visibility?: string }[];
};

type SearchConfig = {
  collectionNameLorebook: string;
  apiKeyLorebook: string;
  collectionNameLorebookEntries: string;
  apiKeyLorebookEntries: string;
};

type LorebookDoc = { id?: string; name?: string };
type EntryDoc = {
  name?: string;
  keywords?: string[];
  content?: string;
  status?: string;
};

// The search keys ship with the app settings, not the bundle, so they can rotate.
async function searchConfig(): Promise<SearchConfig> {
  const res = await fetch(`${API}/v2/applications/spicychat`, {
    headers: apiHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`spicychat: app settings ${res.status}`);
  const body = (await res.json()) as { typesenseConfig?: SearchConfig };
  if (!body.typesenseConfig?.apiKeyLorebookEntries) {
    throw new Error("spicychat: app settings carry no search keys");
  }
  return body.typesenseConfig;
}

async function search<T>(
  collection: string,
  key: string,
  filter: string,
  page: number,
): Promise<{ found: number; docs: T[] }> {
  const res = await fetch(SEARCH, {
    method: "POST",
    headers: { "content-type": "application/json", "x-typesense-api-key": key },
    body: JSON.stringify({
      searches: [
        {
          collection,
          q: "*",
          query_by: "name",
          filter_by: filter,
          per_page: PAGE,
          page,
        },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`spicychat: search ${res.status}`);
  const body = (await res.json()) as {
    results?: { found?: number; hits?: { document: T }[]; error?: string }[];
  };
  const result = body.results?.[0];
  if (!result || result.error) {
    throw new Error(`spicychat: search ${result?.error ?? "empty"}`);
  }
  return {
    found: result.found ?? 0,
    docs: (result.hits ?? []).map((h) => h.document),
  };
}

async function fetchEntries(
  config: SearchConfig,
  lorebookId: string,
): Promise<UniformEntry[]> {
  const docs: EntryDoc[] = [];
  for (let page = 1; ; page++) {
    const got = await search<EntryDoc>(
      config.collectionNameLorebookEntries,
      config.apiKeyLorebookEntries,
      `lorebook_id:=${lorebookId}`,
      page,
    );
    docs.push(...got.docs);
    if (got.docs.length < PAGE || docs.length >= got.found) break;
  }
  return docs.flatMap((e, i) => {
    const keys = (e.keywords ?? [])
      .map((k) => String(k).trim())
      .filter(Boolean);
    const content = String(e.content ?? "").trim();
    if (!content || keys.length === 0) return [];
    return [
      {
        keys,
        content,
        comment: e.name || undefined,
        enabled: e.status === undefined || e.status === "active",
        constant: false,
        selective: false,
        priority: 100,
        orderIndex: i,
        matchWholeWords: false,
      },
    ];
  });
}

async function fetchAvatar(
  path: string | undefined,
): Promise<UniformAsset | undefined> {
  if (!path) return undefined;
  try {
    const img = await fetch(`https://cdn.nd-api.com/${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!img.ok) return undefined;
    return {
      name: "avatar",
      mimeType: img.headers.get("content-type") || "image/jpeg",
      base64: Buffer.from(await img.arrayBuffer()).toString("base64"),
    };
  } catch {
    return undefined;
  }
}

export async function fetchSpicychatLorebook(url: URL): Promise<ImportResult> {
  const id = UUID_RE.exec(url.pathname)?.[0];
  if (!id) throw new Error("spicychat: no lorebook id in url");

  const config = await searchConfig();
  const meta = await search<LorebookDoc>(
    config.collectionNameLorebook,
    config.apiKeyLorebook,
    `id:=${id}`,
    1,
  );
  // Only public books are indexed, so a miss is a private book or a dead link,
  // and the guest API cannot tell those apart either.
  const book = meta.docs[0];
  if (!book) throw new Error("spicychat: lorebook is private or gone");

  const entries = await fetchEntries(config, id);
  if (entries.length === 0) {
    throw new Error("spicychat: lorebook has no importable entries");
  }
  return {
    kind: "lorebook",
    source: "spicychat",
    sourceUrl: url.href,
    lorebooks: [{ name: book.name || "SpicyChat lorebook", entries }],
    skipped: [],
  };
}

export async function fetchSpicychat(url: URL): Promise<ImportResult> {
  // /chat/{character}/{conversation} names the character first.
  const id = UUID_RE.exec(url.pathname)?.[0];
  if (!id) throw new Error("spicychat: no character id in url");

  const res = await fetch(`${API}/v2/characters/${id}`, {
    headers: apiHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 403) throw new Error("spicychat: character is private");
  if (res.status === 404) throw new Error("spicychat: not_found");
  if (!res.ok) throw new Error(`spicychat: character ${res.status}`);

  // An unknown id answers 200 with an empty object.
  const c = (await res.json()) as Character;
  const name = String(c?.name ?? "").trim();
  if (!name) throw new Error("spicychat: not_found");

  const lorebooks: UniformLorebook[] = [];
  const skipped: SkippedLorebook[] = [];
  const attached = (c.lorebooks ?? []).flatMap((b) =>
    b?.id ? [{ ...b, id: b.id }] : [],
  );
  const config = attached.some((b) => b.visibility === "public")
    ? await searchConfig().catch(() => null)
    : null;
  for (const b of attached) {
    const title = b.name || `${name} lorebook`;
    const entries =
      config && b.visibility === "public"
        ? await fetchEntries(config, b.id).catch(() => [])
        : [];
    if (entries.length > 0) lorebooks.push({ name: title, entries });
    else skipped.push({ title, reason: "private" });
  }

  return {
    source: "spicychat",
    sourceUrl: url.href,
    card: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name,
        description: String(c.persona ?? ""),
        personality: "",
        scenario: String(c.scenario ?? ""),
        first_mes: String(c.greeting ?? ""),
        mes_example: String(c.dialogue ?? ""),
        system_prompt: "",
        post_history_instructions: "",
        creator: String(c.creator_username ?? ""),
        creator_notes: String(c.title ?? ""),
        alternate_greetings: [],
        tags: (c.tags ?? []).filter((t) => typeof t === "string"),
        character_version: "",
        extensions: {},
      },
    },
    avatar: await fetchAvatar(c.avatar_url),
    lorebooks,
    skipped,
  };
}
