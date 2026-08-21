import { Elysia } from "elysia";

// A real OpenAI-shaped endpoint, so any client can be pointed at this base URL
// with no custom path: /v1/chat/completions is where they all post.
//
// It exists to answer one question. When a JanitorAI chat runs against a custom
// endpoint, does the prompt it sends carry lorebook entries the site hides from
// the reader? Their frontend bundle contains no upstream call at all (zero hits
// for chat/completions, anthropic, api.openai.com or x-api-key, and no lazy
// chunks), so the request is made server-side and the answer cannot be read off
// the client. One real request settles it.
//
// A diagnostic for our own accounts, not a feature: it records prompt content,
// so it stays off unless DEBUG_ECHO=1, keeps at most CAPACITY requests in
// memory, writes nothing to disk, and drops credentials before storing.

const CAPACITY = 20;
const REDACTED = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "proxy-authorization",
]);

type Captured = {
  at: string;
  path: string;
  headers: Record<string, string>;
  model: unknown;
  messages: Array<{ role: unknown; chars: number; preview: string }>;
};

const captured: Captured[] = [];

export const debugRoutes = new Elysia().guard(
  {
    beforeHandle: ({ status }) =>
      process.env.DEBUG_ECHO === "1" ? undefined : status(404),
  },
  (app) =>
    app
      // Both spellings: clients differ on whether the base URL already ends in
      // /v1, and a 404 here would send the caller looking for a network fault.
      .post("/v1/chat/completions", ({ body, request }) =>
        capture(body, request),
      )
      .post("/chat/completions", ({ body, request }) => capture(body, request))
      .get("/v1/models", () => ({
        object: "list",
        data: [{ id: "echo", object: "model", owned_by: "uno-import" }],
      }))
      .get("/api/debug/last", () => ({ count: captured.length, captured })),
);

function capture(body: unknown, request: Request) {
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headers[k] = REDACTED.has(k.toLowerCase()) ? "<redacted>" : v;
  });

  const payload = body as { model?: unknown; messages?: unknown } | null;
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];

  captured.unshift({
    at: new Date().toISOString(),
    path: new URL(request.url).pathname,
    headers,
    model: payload?.model ?? null,
    messages: messages.map((m: { role?: unknown; content?: unknown }) => {
      const text =
        typeof m?.content === "string"
          ? m.content
          : JSON.stringify(m?.content ?? "");
      return {
        role: m?.role ?? null,
        chars: text.length,
        preview: text.slice(0, 4000),
      };
    }),
  });
  captured.length = Math.min(captured.length, CAPACITY);

  // Answer in the shape an OpenAI client expects, so the caller completes its
  // request instead of retrying and burying the capture.
  return {
    id: "chatcmpl-debug",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: String(payload?.model ?? "echo"),
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "captured" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
  };
}
