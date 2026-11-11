import type {
  ImportResult,
  UniformAsset,
  UniformEntry,
} from "../types/uniform-card";
import { keysFor } from "./janitorai-proxy";

// A Perchance AI Character Chat share link names a gzipped JSON file:
// perchance.org/ai-character-chat?data=Name~<file>.gz, stored on
// user.uploads.dev, which answers a plain fetch.

const TIMEOUT_MS = 20_000;
const UPLOADS = "https://user.uploads.dev/file/";

export const matchesPerchance = (url: URL) =>
  /(^|\.)perchance\.org$/i.test(url.hostname) &&
  /~[\w-]+\.gz$/.test(url.searchParams.get("data") ?? "");

type InitialMessage = { author?: string; content?: string };

type PerchanceCharacter = {
  name?: string;
  roleInstruction?: string;
  reminderMessage?: string;
  initialMessages?: InitialMessage[];
  loreBookUrls?: string[];
  customCode?: string;
  avatar?: { url?: string };
};

const get = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });

async function gunzipJson(res: Response): Promise<unknown> {
  const stream = res.body!.pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

async function fetchAvatar(url?: string): Promise<UniformAsset | undefined> {
  if (!url) return undefined;
  try {
    const img = await get(url);
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

// A lore book is plain text, one entry per paragraph, retrieved by similarity
// rather than keys, so keys come from each entry's own heading.
async function fetchLoreEntries(urls: string[]): Promise<UniformEntry[]> {
  const entries: UniformEntry[] = [];
  for (const url of urls) {
    try {
      const res = await get(url);
      if (!res.ok) continue;
      for (const para of (await res.text()).split(/\n\s*\n/)) {
        const content = para.trim();
        if (content.length < 3) continue;
        const keys = keysFor(content);
        entries.push({
          keys,
          content,
          comment: keys[0] ?? content.split("\n")[0]!.slice(0, 80),
          enabled: true,
          constant: keys.length === 0,
          selective: false,
          priority: 100,
          orderIndex: entries.length,
          matchWholeWords: true,
        });
      }
    } catch {}
  }
  return entries;
}

export async function fetchPerchance(url: URL): Promise<ImportResult> {
  const file = (url.searchParams.get("data") ?? "").split("~").pop();
  if (!file) throw new Error("perchance: no character file in url");
  const res = await get(UPLOADS + file);
  if (!res.ok) throw new Error(`perchance: character file ${res.status}`);
  const body = (await gunzipJson(res)) as { addCharacter?: PerchanceCharacter };
  const c = body?.addCharacter;
  const name = String(c?.name ?? "").trim();
  if (!c || !name) throw new Error("perchance: empty character");

  const greetings = (c.initialMessages ?? [])
    .filter((m) => m.author === "ai" && typeof m.content === "string")
    .map((m) => m.content!);
  const entries = await fetchLoreEntries(c.loreBookUrls ?? []);
  const code = String(c.customCode ?? "").trim();

  return {
    source: "perchance",
    sourceUrl: url.href,
    card: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name,
        description: String(c.roleInstruction ?? ""),
        personality: "",
        scenario: "",
        first_mes: greetings[0] ?? "",
        alternate_greetings: greetings.slice(1),
        mes_example: "",
        system_prompt: "",
        post_history_instructions: String(c.reminderMessage ?? ""),
        creator: "",
        creator_notes: "",
        tags: [],
        character_version: "",
        extensions: {},
      },
    },
    avatar: await fetchAvatar(c.avatar?.url),
    lorebooks: entries.length > 0 ? [{ name: `${name} lore`, entries }] : [],
    skipped: [],
    ...(code
      ? { plugins: [{ name: `${name} code`, script: code, kind: "perchance" }] }
      : {}),
  };
}
