import type { PageWithCursor } from "puppeteer-real-browser";
import type { UniformCard } from "../types/uniform-card";
import { gotoOrigin } from "../worker/page-tools";

// JanitorAI serves a card datacat has never crawled, and serves the DEFINITION of
// a card whose creator hid it, but only to a signed-in session. Both are why an
// import that goes through datacat alone reports "not indexed" for characters the
// site itself shows fine.
//
// Auth is a Supabase session in cookies, so there is no token endpoint to call
// like saucepan has: the login happens in the page, and the profile directory
// keeps the cookies so this runs once per pod rather than once per job.

const EMAIL = process.env.JANITORAI_EMAIL ?? "";
const PASSWORD = process.env.JANITORAI_PASSWORD ?? "";

export const hasJanitorAuth = () => !!EMAIL && !!PASSWORD;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A card page is public; a FAVOURITE is not, so this asks something only a real
// session can answer. /hampter/subscriptions/plans looked like a login check and
// is not: it answers 200 to anonymous callers too.
async function hasSession(page: PageWithCursor): Promise<boolean> {
  try {
    const ok: unknown = await page.evaluate(`(async () => {
      if (!/sb-auth-auth-token/.test(document.cookie)) return false;
      const r = await fetch("/hampter/subscriptions/plans", {
        headers: { accept: "application/json" },
      });
      return r.status === 200;
    })()`);
    return ok === true;
  } catch {
    return false;
  }
}

// Reads the Supabase access token back out of the split cookie pair. The API
// wants it as a bearer even though the cookie is already attached.
async function bearer(page: PageWithCursor): Promise<string | null> {
  try {
    const tok: unknown = await page.evaluate(`(() => {
      const ck = (n) => document.cookie.split("; ")
        .find((c) => c.startsWith(n + "="))?.split("=").slice(1).join("=") || "";
      try {
        const raw = decodeURIComponent(
          ck("sb-auth-auth-token.0") + ck("sb-auth-auth-token.1"),
        ).replace(/^base64-/, "");
        return JSON.parse(atob(raw)).access_token || null;
      } catch { return null; }
    })()`);
    return typeof tok === "string" && tok ? tok : null;
  } catch {
    return null;
  }
}

export async function ensureJanitorLogin(
  page: PageWithCursor,
): Promise<boolean> {
  if (!hasJanitorAuth()) return false;
  if (!page.url().startsWith("https://janitorai.com")) {
    await gotoOrigin(page, "https://janitorai.com/");
  }
  if (await hasSession(page)) return true;

  await gotoOrigin(page, "https://janitorai.com/login");
  await sleep(8000);
  try {
    // Input.insertText, NOT page.type: typing the email through key events stops
    // dead at the "@" on this layout, so the field held 11 of 27 characters and
    // the form never submitted. insertText goes through the path React listens to.
    const put = async (selector: string, value: string) => {
      await page.focus(selector);
      const cdp = await page.createCDPSession();
      await cdp.send("Input.insertText", { text: value });
      await cdp.detach().catch(() => {});
    };
    await put("#email", EMAIL);
    await put("#current-password", PASSWORD);

    // The driver's turnstile solver clicks the widget on its own pages, and the
    // token is what the auth call is rejected without ("captcha_failed").
    for (let i = 0; i < 20; i++) {
      await sleep(3000);
      const solved = await page.evaluate(
        `(() => (document.querySelector('[name="cf-turnstile-response"]')?.value || "").length > 0)()`,
      );
      if (solved) break;
    }

    for (const b of await page.$$("button")) {
      const text = await page.evaluate((el: Element) => el.textContent?.trim() ?? "", b);
      if (/^sign ?in$/i.test(text)) {
        await b.click();
        break;
      }
    }
    for (let i = 0; i < 12; i++) {
      await sleep(3000);
      if (await hasSession(page)) return true;
    }
  } catch {
    // fall through
  }
  return false;
}

type JanitorMeta = {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_message?: string;
  example_dialogs?: string;
  creator_name?: string;
  allow_proxy?: boolean;
  first_messages?: unknown;
  tags?: unknown;
};

// The prompt JanitorAI assembles for a generation, which is the only place a
// hidden definition still exists as text: every read endpoint strips it and sends
// the token COUNTS instead. In proxy mode the endpoint assembles that prompt and
// hands it back to its own caller rather than forwarding it, so one POST returns
// what the card page will not show. Requires allow_proxy on the character.
async function assembledPrompt(
  page: PageWithCursor,
  id: string,
  token: string,
): Promise<string | null> {
  try {
    const text = await page.evaluate(`(async () => {
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
          chatMessages: chat.chatMessages ?? [],
          clientPlatform: "web",
          forcedPromptGenerationCacheRefetch:
            { character: false, chat: false, profile: false, script: false },
          generateMode: "NEW",
          generateType: "CHAT",
          profile: chat.personas?.[0] ?? null,
          profiles: chat.personas ?? [],
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
      if (!g.ok) return null;
      const body = await g.json();
      const sys = (body.messages || []).find(
        (m) => m.role === "system" || /Persona>/.test(m.content || ""),
      );
      return sys?.content || null;
    })()`);
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

// Returns null rather than throwing: this is a fallback for what datacat could
// not serve, and its failure says nothing new about the card.
export async function fetchJanitorCard(
  page: PageWithCursor,
  id: string,
  url: URL,
): Promise<UniformCard | null> {
  if (!(await ensureJanitorLogin(page))) return null;
  const token = await bearer(page);
  if (!token) return null;

  const raw: unknown = await page.evaluate(`(async () => {
    const r = await fetch("/hampter/characters/" + ${JSON.stringify(id)}, {
      headers: {
        accept: "application/json",
        authorization: "Bearer " + ${JSON.stringify(token)},
      },
    });
    return r.ok ? await r.json() : null;
  })()`);
  const meta: JanitorMeta | null =
    raw && typeof raw === "object" ? (raw as JanitorMeta) : null;
  if (!meta?.name) return null;

  const str = (v: unknown) => (typeof v === "string" ? v : "");
  let personality = str(meta.personality);
  let firstMessage = str(meta.first_message);

  // Hidden definition: recoverable only when the creator left proxies on.
  if (!personality && meta.allow_proxy !== false) {
    const prompt = await assembledPrompt(page, id, token);
    if (prompt) {
      const inner = /<[^>]*Persona>([\s\S]*?)<\/[^>]*Persona>/.exec(prompt);
      personality = (inner?.[1] ?? prompt)
        .replace(/<UserPersona>[\s\S]*?<\/UserPersona>/g, "")
        .trim();
    }
  }

  const greetings = Array.isArray(meta.first_messages)
    ? meta.first_messages.filter((m): m is string => typeof m === "string")
    : [];
  if (!firstMessage && greetings[0]) firstMessage = greetings[0];

  return {
    source: "janitorai",
    sourceUrl: url.href,
    card: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: meta.name,
        description: str(meta.description),
        personality,
        scenario: str(meta.scenario),
        first_mes: firstMessage,
        mes_example: str(meta.example_dialogs),
        creator: str(meta.creator_name),
        alternate_greetings: greetings.slice(1),
        tags: Array.isArray(meta.tags)
          ? meta.tags
              .map((t) =>
                typeof t === "string"
                  ? t
                  : str((t as { name?: unknown })?.name),
              )
              .filter(Boolean)
          : [],
        system_prompt: "",
        post_history_instructions: "",
        character_version: "",
        extensions: {},
      },
    },
    lorebooks: [],
    skipped: [],
  };
}
