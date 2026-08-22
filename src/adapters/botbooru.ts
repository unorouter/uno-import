import type {
  ImportResult,
  UniformAsset,
  UniformEntry,
  UniformLorebook,
} from "../types/uniform-card";

// Botbooru answers a plain request from the cluster, so this fetches directly
// rather than through the browser, as saucepan does.
//
// Two id spaces, and mixing them is the trap: a character URL carries the POST
// id and reads from /post/{id}, while a lorebook URL carries its NUMBER and
// downloads from /api/lorebooks/{number}/download.json. Passing a lorebook's
// `id` to that route 404s even though the book exists.
//
// The character route is at the ROOT rather than under /api; asking
// /api/posts/{id} returns the SPA shell with a 200, which reads like success
// until the body turns out to be HTML.

export const matchesBotbooru = (url: URL) =>
  /^(www\.)?botbooru\.com$/i.test(url.hostname);

export const matchesBotbooruLorebook = (url: URL) =>
  matchesBotbooru(url) && /^\/lorebooks?\//i.test(url.pathname);

const idFromPath = (url: URL): string | null =>
  /(\d+)/.exec(url.pathname.split("/").filter(Boolean).pop() ?? "")?.[1] ?? null;

const TIMEOUT_MS = 20_000;

const json = async <T>(url: string): Promise<T | null> => {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  // The SPA shell answers 200 for unknown paths, so a JSON content type is the
  // only reliable signal that the route exists.
  if (!/application\/json/i.test(res.headers.get("content-type") ?? "")) {
    return null;
  }
  return (await res.json()) as T;
};

type RawEntry = {
  key?: string[];
  keysecondary?: string[];
  content?: string;
  comment?: string;
  constant?: boolean;
  selective?: boolean;
  order?: number;
  insertion_order?: number;
  enabled?: boolean;
  disable?: boolean;
};

type RawBook = {
  name?: string;
  scan_depth?: number;
  entries?: RawEntry[] | Record<string, RawEntry>;
};

function toEntries(book: RawBook): UniformEntry[] {
  const raw = book.entries;
  const list = Array.isArray(raw) ? raw : Object.values(raw ?? {});
  return list.flatMap((e, i) => {
    const content = String(e?.content ?? "").trim();
    if (!content) return [];
    const keys = (e.key ?? []).map((k) => String(k).trim()).filter(Boolean);
    return [
      {
        keys,
        secondaryKeys: (e.keysecondary ?? []).map(String).filter(Boolean),
        content,
        comment: String(e.comment ?? ""),
        // `disable` is the SillyTavern spelling and wins when present: a book
        // exported with everything disabled must not import as all-on.
        enabled: e.disable === true ? false : (e.enabled ?? true),
        constant: e.constant ?? false,
        selective: e.selective ?? false,
        priority: 100,
        orderIndex: e.insertion_order ?? e.order ?? i,
        matchWholeWords: false,
      },
    ];
  });
}

async function fetchBook(numberId: string): Promise<UniformLorebook | null> {
  const book = await json<RawBook>(
    `https://botbooru.com/api/lorebooks/${numberId}/download.json`,
  );
  if (!book) return null;
  const entries = toEntries(book);
  if (entries.length === 0) return null;
  return {
    name: book.name || `Botbooru lorebook ${numberId}`,
    scanDepth: book.scan_depth,
    entries,
  };
}

export async function fetchBotbooruLorebook(url: URL): Promise<ImportResult> {
  const id = idFromPath(url);
  if (!id) throw new Error("botbooru: no lorebook number in url");

  const book = await fetchBook(id);
  if (!book) throw new Error("botbooru: lorebook not found");

  return {
    kind: "lorebook",
    source: "botbooru",
    sourceUrl: url.href,
    lorebooks: [book],
    skipped: [],
  };
}

type Post = {
  character_name?: string;
  filename?: string;
  image_link?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creator_notes?: string;
  system_prompt?: string;
  post_history_instructions?: string;
  alternate_greetings?: string[];
  uploader_name?: string;
  tags?: Array<{ name?: string } | string>;
  has_lorebook?: boolean;
  lorebook_json?: RawBook | null;
  companion_lorebooks?: Array<{ number?: number; title?: string }>;
};

export async function fetchBotbooru(url: URL): Promise<ImportResult> {
  const id = idFromPath(url);
  if (!id) throw new Error("botbooru: no character id in url");

  const post = await json<Post>(`https://botbooru.com/post/${id}`);
  if (!post) throw new Error("botbooru: character not found");

  const name = String(post.character_name ?? "").trim();
  if (!name) throw new Error("botbooru: character not found");

  let avatar: UniformAsset | undefined;
  const src =
    post.image_link ||
    (post.filename ? `https://botbooru.com/images/${post.filename}` : "");
  if (src) {
    try {
      const r = await fetch(src, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.ok) {
        avatar = {
          name: "avatar",
          mimeType: r.headers.get("content-type") || "image/png",
          base64: Buffer.from(await r.arrayBuffer()).toString("base64"),
        };
      }
    } catch {}
  }

  const lorebooks: UniformLorebook[] = [];
  if (post.lorebook_json) {
    const entries = toEntries(post.lorebook_json);
    if (entries.length > 0) {
      lorebooks.push({
        name: post.lorebook_json.name || `${name} lorebook`,
        scanDepth: post.lorebook_json.scan_depth,
        entries,
      });
    }
  }
  // Books the uploader attached alongside the card rather than inside it.
  for (const ref of post.companion_lorebooks ?? []) {
    if (ref?.number == null) continue;
    const book = await fetchBook(String(ref.number));
    if (book) lorebooks.push(book);
  }

  return {
    source: "botbooru",
    sourceUrl: url.href,
    card: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name,
        description: String(post.description ?? ""),
        personality: String(post.personality ?? ""),
        scenario: String(post.scenario ?? ""),
        first_mes: String(post.first_mes ?? ""),
        mes_example: String(post.mes_example ?? ""),
        creator: String(post.uploader_name ?? ""),
        creator_notes: String(post.creator_notes ?? ""),
        system_prompt: String(post.system_prompt ?? ""),
        post_history_instructions: String(post.post_history_instructions ?? ""),
        alternate_greetings: post.alternate_greetings ?? [],
        tags: (post.tags ?? []).map((t) =>
          typeof t === "string" ? t : String(t?.name ?? ""),
        ),
        character_version: "",
        extensions: {},
      },
    },
    avatar,
    lorebooks,
    skipped:
      post.has_lorebook && lorebooks.length === 0
        ? [{ title: `${name} lorebook`, reason: "private" as const }]
        : [],
  };
}
