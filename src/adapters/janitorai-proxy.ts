import type { PageWithCursor } from "puppeteer-real-browser";
import type { UniformEntry } from "../types/uniform-card";

// In proxy mode /generateAlpha hands the assembled prompt back to its caller
// instead of sending it anywhere, and that prompt is the only place a hidden
// definition and the entries of a private lorebook survive as text.
//
// Entries fire by keyword and by chance, under a per prompt cap, so one prompt
// holds a random handful of them (4 to 20 of 44 on a 4 book bot). Many prompts
// with varied keywords hold nearly all: a line present in every prompt is the
// definition, and lines that come and go together are one entry. The keys never
// reach the prompt, so an entry is keyed by the name in its own heading.

// generateAlpha allows a burst of about 6 calls, then one per 2 seconds.
const GAP_MS = 2_100;
const RETRY_429_MS = 6_000;
// On that bot the set of lines stopped growing after about 20 prompts.
const QUIET_STOP = 8;
const PROBE_WORDS = 80;
// Stands in for the importing account's persona name, which JanitorAI writes
// wherever the definition says {{user}}.
const USER = "UNOIMPORTUSER";

export type ProxyRecovery = {
  greeting: string | null;
  personality: string;
  scenario: string;
  examples: string;
  entries: UniformEntry[];
};

// The page answers with a JSON string, the only shape page.evaluate carries
// back intact.
function readGen(raw: unknown): { status: number; prompt: string } {
  if (typeof raw !== "string") return { status: 0, prompt: "" };
  const v: unknown = JSON.parse(raw);
  if (!v || typeof v !== "object") return { status: 0, prompt: "" };
  const status = "status" in v && typeof v.status === "number" ? v.status : 0;
  const prompt = "prompt" in v && typeof v.prompt === "string" ? v.prompt : "";
  return { status, prompt };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const setupScript = (id: string, token: string) => `(async () => {
  const H = {
    accept: "application/json",
    "content-type": "application/json",
    authorization: "Bearer " + ${JSON.stringify(token)},
  };
  const made = await fetch("/hampter/chats", {
    method: "POST", headers: H,
    body: JSON.stringify({ character_id: ${JSON.stringify(id)} }),
  });
  if (!made.ok) return null;
  const j = await made.json();
  const chatId = j?.id ?? j?.chat?.id;
  if (!chatId) return null;
  const chat = await (await fetch("/hampter/chats/" + chatId, { headers: H })).json();
  const c = chat.chat || {};
  const opener = (chat.chatMessages || []).find((m) => m && m.is_bot);
  const profile = { ...(chat.personas?.[0] || {}), name: ${JSON.stringify(USER)} };
  window.__unoProxy = {
    // A DELETE carrying a content-type answers 400 on an empty body.
    drop: () => fetch("/hampter/chats/" + chatId, {
      method: "DELETE",
      headers: { accept: "application/json", authorization: H.authorization },
    }).then(() => true, () => false),
    gen: async (text) => {
      const g = await fetch("/generateAlpha", {
        method: "POST", headers: H,
        body: JSON.stringify({
          // Exactly the four fields the site sends: posting the full chat row
          // back is what the API rejects.
          chat: {
            character_id: c.character_id ?? ${JSON.stringify(id)},
            id: c.id ?? chatId,
            summary: c.summary ?? "",
            user_id: c.user_id,
          },
          // The probe alone, without the greeting, so its keywords do not
          // trigger entries in every prompt.
          chatMessages: [{ ...(opener || {}), id: undefined, is_bot: false, message: text, is_main: true }],
          clientPlatform: "web",
          forcedPromptGenerationCacheRefetch:
            { character: false, chat: false, profile: false, script: false },
          generateMode: "NEW",
          generateType: "CHAT",
          profile,
          profiles: [profile],
          // open_ai_mode "proxy" is the whole trick. The endpoint validates the
          // shape but never contacts the endpoint named, so it can be anything;
          // an incomplete userConfig answers 502 "your AI provider rejected the
          // API key" while it tries to call a provider for real.
          userConfig: {
            api: "openai", open_ai_mode: "proxy",
            open_ai_reverse_proxy: "https://example.invalid/v1/chat/completions",
            reverseProxyKey: "extract", openAiModel: "gpt-4",
            openAIKey: null, claudeApiKey: null, claudeModel: "",
            claude_jailbreak_prompt: "", open_ai_jailbreak_prompt: "",
            proxy_global_prompt: "", llm_prompt: "", bad_words: [],
            allow_mobile_nsfw: true, janitor_router_enabled: false,
            text_streaming: false,
            generation_settings: {
              context_length: 50000, enable_reasoning: false,
              enable_reasoning_chat: false, enable_router_temperature: false,
              enable_short_responses: false, max_new_token: 0,
              prefill_enabled: false, prefill_text: "", temperature: 1,
            },
          },
        }),
      });
      if (!g.ok) return JSON.stringify({ status: g.status });
      const body = await g.json();
      const sys = (body.messages || []).find(
        (m) => m.role === "system" || /Persona>/.test(m.content || ""),
      );
      return JSON.stringify({ status: 200, prompt: sys?.content || "" });
    },
  };
  return JSON.stringify({ greeting: typeof opener?.message === "string" ? opener.message : null });
})()`;

type Region = "persona" | "scenario" | "examples" | "outside";
type Line = { region: Region; text: string; tag: boolean };

// Entries land inside the definition blocks and after them, so the whole prompt
// is read as lines, each knowing which block it sits in.
function linesOf(prompt: string): Line[] {
  const out: Line[] = [];
  let region: Region = "outside";
  // Only the block tags: example dialogs carry "<START>" as text.
  const cleaned = prompt
    .replace(/<UserPersona>[\s\S]*?<\/UserPersona>/g, "")
    .replaceAll(USER, "{{user}}")
    .replace(/(<\/?(?:[^<>\n]*Persona|Scenario|example_dialogs)>)/g, "\n$1\n");
  for (const raw of cleaned.split("\n")) {
    const t = raw.trim();
    const tag = /^<\/?(?:[^<>\n]*Persona|Scenario|example_dialogs)>$/.test(t);
    if (tag) {
      region = t.startsWith("</")
        ? "outside"
        : t === "<Scenario>"
          ? "scenario"
          : t === "<example_dialogs>"
            ? "examples"
            : "persona";
    }
    out.push({ region, text: tag ? t : raw, tag });
  }
  return out;
}

const STOP = new Set(
  "The This That These Those There Their They Then When What Where Which While With Without Would Could Should Will Your You Our His Her Its And But For From Into Onto Over Under After Before During About Also Always Never Only Very Most More Some Each Every Other Another Such Name Age Height Weight Personality Likes Dislikes Backstory Relationships Body Overall Style Appearance Note Notes Rules".split(
    " ",
  ),
);

function harvest(text: string, into: Set<string>) {
  for (const m of text.matchAll(
    /\b[A-Z][a-zA-Z'’]{2,}(?:[ -][A-Z][a-zA-Z'’]{2,}){0,2}\b/g,
  )) {
    if (!STOP.has(m[0])) into.add(m[0]);
  }
}

// A heading names what the entry is about, and that name is what a reader types
// when the entry should fire: "Name: Ken Ryuguji (Aka Draken)", "**Tenjiku Arc**".
export function keysFor(content: string): string[] {
  const head = content
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!head) return [];
  const keys = new Set<string>();
  const add = (k: string) => {
    const v = k.replace(/["“”[\]*]/g, "").trim();
    if (v.length >= 3 && !STOP.has(v)) keys.add(v);
  };

  const addName = (name: string) => {
    const main = name.replace(/\(.*?\)/g, "").replace(/\].*$/, "");
    add(main);
    for (const m of name.matchAll(/\(([^)]+)\)/g)) {
      add(m[1]!.replace(/^(aka|a\.k\.a\.)\s+/i, ""));
    }
    return main;
  };

  const named =
    /(?:^|[\s[(•*-])(?:Name|Character)\s*[:=]\s*(.+)$/i.exec(head)?.[1] ??
    /(?:Name|Character)\s*\(\s*["“]([^"”]+)["”]/i.exec(head)?.[1];
  if (named) {
    for (const part of addName(named).split(/\s+/)) add(part);
    return [...keys];
  }

  for (const m of head.matchAll(/\*\*([^*]{2,60})\*\*/g)) {
    for (const part of m[1]!.split(/\s*\/\s*/)) {
      const main = addName(part);
      if (/\s(Arc|Gang)$/i.test(main)) add(main.replace(/\s(Arc|Gang)$/i, ""));
    }
  }
  if (keys.size > 0) return [...keys];

  // "Tokyo Manji Gang (Toman) is the main gang" opens on its subject.
  const subject =
    /^([A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*){0,4}(?:\s*\([^)]+\))?)\s+(?:is|was|are|were)\s/.exec(
      head,
    )?.[1];
  if (subject) {
    addName(subject);
    return [...keys];
  }

  // "Toman: the gang Mikey founded" names its subject before the colon. A line
  // that is only a title ("Core Rules & Values:") names a topic, not a word
  // anyone types, and stays keyless.
  const titled = /^([A-Z][\w'’&. -]{1,40}):\s+\S/.exec(head)?.[1];
  if (titled && titled.split(/\s+/).length <= 4) add(titled);
  return [...keys];
}

type Candidate = { content: string; seen: number };

// Pure, so it can be checked against saved prompts without a browser.
export function analyse(prompts: string[]) {
  const parsed = prompts.map(linesOf);
  const n = parsed.length;
  const presence = new Map<string, Set<number>>();
  parsed.forEach((lines, i) => {
    for (const l of lines) {
      const t = l.text.trim();
      if (!t || l.tag) continue;
      const at = presence.get(t) ?? new Set<number>();
      at.add(i);
      presence.set(t, at);
    }
  });
  const stable = (t: string) => presence.get(t)?.size === n;

  const definition = (region: Region) =>
    (parsed[0] ?? [])
      .filter((l) => l.region === region && !l.tag)
      .map((l) => l.text)
      .filter((t) => !t.trim() || stable(t.trim()))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  // Lines that always arrive together belong to one entry. Two entries that
  // always arrive together merge, which changes nothing about when they fire.
  const groups = new Map<string, Set<string>>();
  for (const [t, at] of presence) {
    if (at.size === n) continue;
    const sig = [...at].sort((a, b) => a - b).join(",");
    groups.set(sig, (groups.get(sig) ?? new Set<string>()).add(t));
  }

  const found: Candidate[] = [];
  for (const [sig, own] of groups) {
    const at = sig.split(",").map(Number);
    const lines = parsed[at[0]!]!;
    // A line present whenever this entry is, but also elsewhere, is shared with
    // another entry: a heading two books both carry, or "Age: 15 (past)". A
    // short line present everywhere is one an always-on entry shares with it.
    const passable = (t: string) => {
      const p = presence.get(t);
      if (!p || own.has(t)) return !!p;
      if (stable(t)) return t.length < 40;
      return at.every((i) => p.has(i));
    };
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.tag || !own.has(lines[i]!.text.trim())) continue;
      let start = i;
      while (start > 0) {
        const prev = lines[start - 1]!;
        if (prev.tag || !prev.text.trim() || !passable(prev.text.trim())) break;
        start--;
      }
      let end = i;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j]!.text.trim();
        if (lines[j]!.tag || (t && !passable(t))) break;
        if (own.has(t)) end = j;
      }
      const content = lines
        .slice(start, end + 1)
        .map((l) => l.text)
        .join("\n")
        .trim();
      if (content.length >= 20) found.push({ content, seen: at.length });
      i = end;
    }
  }

  // Keep the fullest copy of each entry: a group of shared lines yields a
  // fragment of a real entry, and a random macro yields one variant per pick.
  found.sort((a, b) => b.content.length - a.content.length);
  const kept: Candidate[] = [];
  for (const c of found) {
    const twin = kept.find(
      (k) =>
        k.content.includes(c.content) ||
        k.content.slice(0, 50) === c.content.slice(0, 50),
    );
    if (twin) twin.seen = Math.max(twin.seen, c.seen);
    else kept.push(c);
  }

  const entries: UniformEntry[] = kept.map((c, i) => {
    const keys = keysFor(c.content);
    return {
      keys,
      content: c.content,
      comment: c.content.split("\n")[0]!.trim().slice(0, 80),
      enabled: true,
      // Without a nameable heading there is nothing to key on, so it fires about
      // as often as it showed up here.
      constant: keys.length === 0,
      ...(keys.length === 0
        ? {
            chance: Math.min(
              95,
              Math.max(5, Math.round((100 * c.seen) / n / 5) * 5),
            ),
          }
        : {}),
      selective: false,
      priority: 100,
      orderIndex: i,
      // Name parts are short ("Ken"), and as substrings they fire on "spoken".
      matchWholeWords: true,
    };
  });

  return {
    personality: definition("persona"),
    scenario: definition("scenario"),
    examples: definition("examples"),
    entries,
  };
}

export async function recoverViaProxy(
  page: PageWithCursor,
  id: string,
  token: string,
  opts: { probes: number; seedText: string },
): Promise<ProxyRecovery | null> {
  const raw: unknown = await page.evaluate(setupScript(id, token));
  if (typeof raw !== "string") return null;
  const setup: { greeting?: unknown } = JSON.parse(raw);
  const greeting = typeof setup.greeting === "string" ? setup.greeting : null;

  const prompts: string[] = [];
  try {
    const words = new Set<string>();
    harvest(opts.seedText, words);
    if (greeting) harvest(greeting, words);
    const lines = new Set<string>();
    let quiet = 0;
    let limited = 0;
    while (prompts.length < opts.probes && quiet < QUIET_STOP) {
      if (prompts.length > 0 || limited > 0) await sleep(GAP_MS);
      const pick = [...words]
        .filter(() => Math.random() < 0.35)
        .slice(0, PROBE_WORDS);
      const got = readGen(
        await page.evaluate(
          `window.__unoProxy.gen(${JSON.stringify(pick.join(", ") || "...")})`,
        ),
      );
      if (got.status === 429) {
        if (++limited > 3) break;
        await sleep(RETRY_429_MS);
        continue;
      }
      if (got.status !== 200 || !got.prompt) break;
      limited = 0;
      prompts.push(got.prompt);
      let fresh = 0;
      for (const line of got.prompt.split("\n")) {
        const t = line.trim();
        if (t && !lines.has(t)) {
          lines.add(t);
          harvest(t, words);
          fresh++;
        }
      }
      quiet = fresh > 0 ? 0 : quiet + 1;
    }
  } finally {
    await page.evaluate(`window.__unoProxy.drop()`).catch(() => {});
  }
  return { greeting, ...analyse(prompts) };
}
