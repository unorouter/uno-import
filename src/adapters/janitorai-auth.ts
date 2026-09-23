import type { PageWithCursor } from "puppeteer-real-browser";
import type { UniformCard } from "../types/uniform-card";
import { gotoOrigin } from "../worker/page-tools";
import { toEntries } from "./entries";
import { recoverLorebooks } from "./janitorai";
import { recoverViaProxy } from "./janitorai-proxy";

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
      const text = await page.evaluate(
        (el: Element) => el.textContent?.trim() ?? "",
        b,
      );
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

// The avatar is a bare filename on the character row, and the bytes live on a
// different host. Fetched in the page so the request carries the same clearance
// as everything else here, and base64 because binary cannot cross page.evaluate.
async function fetchAvatar(
  page: PageWithCursor,
  avatar: string,
): Promise<{ name: string; mimeType: string; base64: string } | undefined> {
  if (!avatar) return undefined;
  try {
    const got: unknown = await page.evaluate(`(async () => {
      const a = ${JSON.stringify(avatar)};
      const src = /^https?:/.test(a)
        ? a
        : "https://ella.janitorai.com/bot-avatars/" + a;
      try {
        const r = await fetch(src);
        if (!r.ok) return null;
        const buf = new Uint8Array(await r.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 8192) {
          bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
        }
        return JSON.stringify({
          name: "avatar",
          mimeType: r.headers.get("content-type") || "image/webp",
          base64: btoa(bin),
        });
      } catch (e) { return null; }
    })()`);
    if (typeof got !== "string") return undefined;
    const parsed: unknown = JSON.parse(got);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { base64?: unknown }).base64 === "string"
    ) {
      return parsed as { name: string; mimeType: string; base64: string };
    }
  } catch {
    // an avatar is not worth failing the import over
  }
  return undefined;
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
  avatar?: unknown;
  scripts?: { type?: string; id?: string; title?: string }[];
};

async function fetchMeta(
  page: PageWithCursor,
  id: string,
  token: string,
): Promise<JanitorMeta | null> {
  const raw: unknown = await page.evaluate(`(async () => {
    const r = await fetch("/hampter/characters/" + ${JSON.stringify(id)}, {
      headers: {
        accept: "application/json",
        authorization: "Bearer " + ${JSON.stringify(token)},
      },
    });
    return r.ok ? await r.json() : null;
  })()`);
  return raw && typeof raw === "object" ? (raw as JanitorMeta) : null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

// Every read endpoint strips a hidden definition and a private lorebook alike,
// and both survive only in the prompt JanitorAI assembles for a proxy.
async function completeCard(
  page: PageWithCursor,
  id: string,
  token: string,
  meta: JanitorMeta,
  card: UniformCard,
) {
  const data = card.card.data;
  const books = (meta.scripts ?? []).flatMap((s) =>
    s.type === "lorebook" && s.id
      ? [{ id: s.id, title: s.title || "Untitled" }]
      : [],
  );
  const have = new Set(card.lorebooks.map((b) => b.name));
  let missing = books.filter((b) => !have.has(b.title));
  if (missing.length > 0) {
    const direct = await recoverLorebooks(
      page,
      missing.map((b) => b.id),
      toEntries,
    ).catch(() => []);
    card.lorebooks.push(...direct);
    const fetched = new Set(direct.map((b) => b.name));
    missing = missing.filter((b) => !fetched.has(b.title));
  }
  const hidden = !str(meta.personality);
  if (!hidden && missing.length === 0 && str(data.first_mes)) return;

  const withheld = () => {
    for (const b of missing) {
      if (!card.skipped.some((s) => s.title === b.title)) {
        card.skipped.push({ title: b.title, reason: "private" });
      }
    }
  };
  // With the proxy off, one prompt still yields the greeting a hidden
  // definition withholds, which opening the chat materialises.
  const proxy = meta.allow_proxy !== false;
  const got = await recoverViaProxy(page, id, token, {
    probes: !proxy ? 1 : missing.length > 0 ? 25 : books.length > 0 ? 8 : 1,
    seedText: [
      str(meta.description).replace(/<[^>]+>/g, " "),
      str(data.first_mes),
      str(data.scenario),
    ].join("\n"),
  }).catch(() => null);
  if (got?.greeting && !str(data.first_mes)) data.first_mes = got.greeting;
  if (!got || !proxy) return withheld();
  if (hidden) {
    if (got.personality) data.personality = got.personality;
    if (got.scenario) data.scenario = got.scenario;
    if (got.examples) data.mes_example = got.examples;
  }
  if (missing.length === 0) return;
  if (got.entries.length === 0) return withheld();
  const [only] = missing;
  const title =
    missing.length === 1 && only ? only.title : `${str(data.name)} lorebook`;
  // Marked because its keys come from each entry's heading, not the author's.
  card.lorebooks.push({ name: `${title} (recovered)`, entries: got.entries });
  const gone = new Set(missing.map((b) => b.title));
  card.skipped = card.skipped.filter((s) => !gone.has(s.title));
}

// datacat never lists some books, and serves a hidden definition as whatever
// one prompt happened to hold, so a signed-in session completes its card.
export async function completeFromJanitor(
  page: PageWithCursor,
  id: string,
  card: UniformCard,
): Promise<void> {
  if (!(await ensureJanitorLogin(page))) return;
  const token = await bearer(page);
  if (!token) return;
  const meta = await fetchMeta(page, id, token);
  if (meta) await completeCard(page, id, token, meta, card);
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

  const meta = await fetchMeta(page, id, token);
  if (!meta?.name) return null;

  const firstMessage = str(meta.first_message);
  // A hidden definition takes the MAIN greeting with it, and only that one:
  // first_messages keeps its length and turns entry 0 into null, so the
  // alternates still arrive. Dropping the hole instead of filling it promoted
  // the first alternate to greeting, and a card whose only greeting was the
  // hidden one imported with none at all.
  const list = Array.isArray(meta.first_messages) ? meta.first_messages : [];
  const greetings = list.filter((m): m is string => typeof m === "string");
  const head: unknown = list[0];
  const greeting = firstMessage || (typeof head === "string" ? head : "");
  // Whatever became the greeting is not also an alternate.
  const alternates = greetings.filter((g) => g !== greeting);

  const avatar = await fetchAvatar(
    page,
    typeof meta.avatar === "string" ? meta.avatar : "",
  );

  const card: UniformCard = {
    source: "janitorai",
    sourceUrl: url.href,
    avatar,
    card: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: meta.name,
        description: str(meta.description),
        personality: str(meta.personality),
        scenario: str(meta.scenario),
        first_mes: greeting,
        mes_example: str(meta.example_dialogs),
        creator: str(meta.creator_name),
        alternate_greetings: alternates,
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
  await completeCard(page, id, token, meta, card);
  return card;
}
