import { Elysia } from "elysia";

// Answers one open question: when a JanitorAI chat is pointed at a custom
// endpoint, does the assembled prompt carry lorebook entries the site hides from
// the reader? Their frontend bundle contains no upstream call at all (zero hits
// for chat/completions, anthropic, api.openai.com, x-api-key, and no lazy
// chunks), so the request is made server-side and the answer cannot be read off
// the client. One real request settles it.
//
// A diagnostic for our own accounts, not a feature. It records prompt content,
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
      .post("/api/debug/echo", ({ body, request }) => {
        const headers: Record<string, string> = {};
        request.headers.forEach((v, k) => {
          headers[k] = REDACTED.has(k.toLowerCase()) ? "<redacted>" : v;
        });

        const payload = body as { model?: unknown; messages?: unknown } | null;
        const messages = Array.isArray(payload?.messages)
          ? payload.messages
          : [];

        captured.unshift({
          at: new Date().toISOString(),
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

        // Answer in the shape an OpenAI client expects, so the caller completes
        // its request instead of retrying and burying the capture.
        return {
          id: "chatcmpl-debug",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: String(payload?.model ?? "debug"),
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "captured" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
        };
      })
      .get("/api/debug/last", () => ({ count: captured.length, captured })),
);
