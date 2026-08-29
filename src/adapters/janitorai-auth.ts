import type { PageWithCursor } from "puppeteer-real-browser";
import type { UniformCard } from "../types/uniform-card";
import { gotoOrigin } from "../worker/page-tools";

// JanitorAI serves an explicit or login-gated character only to a signed-in
// session: the SSR payload comes back with `character: null` and a 302 to
// /login, and /hampter/characters/{id} answers 401 gated_explicit_content. That
// is the ONLY thing datacat's crawl works around, so a card datacat has not
// indexed is unreachable until this browser is logged in.
//
// Unlike saucepan there is no token endpoint to call: auth is a Supabase session
// living in cookies, so the login has to happen in the page. The profile dir
// (customConfig.userDataDir) keeps those cookies across restarts, and this only
// runs when they have expired.

const EMAIL = process.env.JANITORAI_EMAIL ?? "";
const PASSWORD = process.env.JANITORAI_PASSWORD ?? "";

export const hasJanitorAuth = () => !!EMAIL && !!PASSWORD;

// Cheap enough to run before a janitorai job rather than tracking expiry: the
// cookie outlives most pod lifetimes, so this is normally one 401-free fetch.
export async function isJanitorLoggedIn(
  page: PageWithCursor,
): Promise<boolean> {
  try {
    const status = await page.evaluate(`(async () => {
      const r = await fetch("/hampter/subscriptions/plans", {
        headers: { accept: "application/json" },
      });
      return r.status;
    })()`);
    return status === 200;
  } catch {
    return false;
  }
}

// Returns false rather than throwing: a janitorai job can still succeed through
// datacat, and failing the whole import because a bonus path is unavailable
// would be a regression for every card datacat DOES have.
export async function ensureJanitorLogin(
  page: PageWithCursor,
): Promise<boolean> {
  if (!hasJanitorAuth()) return false;
  if (!page.url().startsWith("https://janitorai.com")) {
    await gotoOrigin(page, "https://janitorai.com/");
  }
  if (await isJanitorLoggedIn(page)) return true;

  await gotoOrigin(page, "https://janitorai.com/login");
  try {
    // Field order rather than names: the form is React-rendered with generated
    // ids, and the email/password pair is the only text+password pair on it.
    await page.waitForSelector('input[type="password"]', { timeout: 20000 });
    const filled = await page.evaluate(
      `(() => {
        const set = (el, v) => {
          const proto = Object.getPrototypeOf(el);
          Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const pw = document.querySelector('input[type="password"]');
        const inputs = [...document.querySelectorAll("input")];
        const email = inputs[inputs.indexOf(pw) - 1];
        if (!pw || !email) return false;
        set(email, ${JSON.stringify(EMAIL)});
        set(pw, ${JSON.stringify(PASSWORD)});
        return true;
      })()`,
    );
    if (!filled) return false;

    await page.evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => /log ?in|sign ?in/i.test(b.textContent || "") && !b.disabled,
      );
      btn?.click();
    })()`);

    // The redirect off /login is the success signal; a wrong password simply
    // stays put with an inline error, so a timeout here IS the failure.
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await isJanitorLoggedIn(page)) return true;
    }
  } catch {
    // fall through to false
  }
  return false;
}

// The card as JanitorAI itself serves it, for the case datacat cannot cover: a
// character it has not crawled. Needs the session above, and returns null rather
// than throwing so the caller can keep datacat's error as the reported one.
export async function fetchJanitorCard(
  page: PageWithCursor,
  id: string,
): Promise<Record<string, unknown> | null> {
  if (!(await ensureJanitorLogin(page))) return null;
  const raw = await page.evaluate(`(async () => {
    const r = await fetch("/hampter/characters/" + ${JSON.stringify(id)}, {
      headers: { accept: "application/json" },
    });
    if (!r.ok) return null;
    return JSON.stringify(await r.json());
  })()`);
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// JanitorAI's own row mapped onto the shape every other adapter emits. Fields are
// named for the character-card spec rather than JanitorAI's columns, and the
// definition fields stay EMPTY when the creator hid them: the site sends token
// counts without the text, so an import of a hidden card is a name and an avatar
// and nothing to roleplay. Reporting that honestly beats inventing content.
export function janitorToUniform(
  body: Record<string, unknown>,
  url: URL,
): UniformCard {
  const rec = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const c = rec(body.character ?? body);

  return {
    source: "janitorai",
    sourceUrl: url.href,
    card: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: str(c.name) || "Imported character",
        description: str(c.description),
        personality: str(c.personality),
        scenario: str(c.scenario),
        first_mes: str(c.first_message),
        mes_example: str(c.example_dialogs),
        creator: str(c.creator_name),
        alternate_greetings: Array.isArray(c.first_messages)
          ? c.first_messages.slice(1).filter((m): m is string => typeof m === "string")
          : [],
        tags: Array.isArray(c.tags)
          ? c.tags
              .map((t) => (typeof t === "string" ? t : str(rec(t).name)))
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
