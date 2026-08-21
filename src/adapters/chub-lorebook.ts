import type { PageWithCursor } from "puppeteer-real-browser";
import type { ImportResult, UniformLorebook } from "../types/uniform-card";
import { evaluateOn } from "../worker/page-tools";

// A lorebook published on its own, rather than one attached to a character.
// chub stores it as a file in a git project, so it takes two calls: the node
// carries the project id, and the raw file carries the entries.
const CHUB_HOSTS = /^(www\.)?(chub\.ai|characterhub\.org)$/i;

export const matchesChubLorebook = (url: URL) =>
  CHUB_HOSTS.test(url.hostname) &&
  url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() === "lorebooks";

const FETCH_IN_PAGE = `(async (path) => {
  const node = await fetch("https://api.chub.ai/api/lorebooks/" + path, {
    headers: { accept: "application/json" },
  });
  if (!node.ok) return { error: "node " + node.status };
  const id = (await node.json())?.node?.id;
  if (!id) return { error: "no project id" };

  // The path is double-encoded on purpose: it is a git file path nested inside
  // a URL path, so %252F is what reaches the API as %2F.
  const raw = await fetch(
    "https://api.chub.ai/api/v4/projects/" + id +
      "/repository/files/raw%252Fsillytavern_raw.json/raw",
    { headers: { accept: "application/json" } },
  );
  if (!raw.ok) return { error: "raw " + raw.status };
  return { book: await raw.json() };
})`;

type WorldInfo = {
  name?: string;
  scan_depth?: number;
  // SillyTavern keys entries by index rather than storing an array.
  entries?: Record<string, unknown> | unknown[];
};

export async function fetchChubLorebook(
  page: PageWithCursor,
  url: URL,
  toEntries: (raw: string) => UniformLorebook["entries"],
): Promise<ImportResult> {
  const parts = url.pathname.split("/").filter(Boolean);
  const creator = parts[1];
  const project = parts[2];
  if (!creator || !project) throw new Error("chub: no creator/project in url");

  const out = await evaluateOn<{ error?: string; book?: WorldInfo }>(
    page,
    "https://chub.ai/",
    `${FETCH_IN_PAGE}(${JSON.stringify(`${creator}/${project}`)})`,
  );
  if (out?.error || !out?.book) {
    throw new Error(`chub: ${out?.error ?? "empty"}`);
  }

  const raw = out.book.entries;
  const list = Array.isArray(raw) ? raw : Object.values(raw ?? {});
  const entries = toEntries(JSON.stringify(list));
  if (entries.length === 0) throw new Error("chub: lorebook has no entries");

  return {
    kind: "lorebook",
    source: "chub",
    sourceUrl: url.href,
    lorebooks: [
      {
        name: out.book.name || project,
        scanDepth: out.book.scan_depth,
        entries,
      },
    ],
    skipped: [],
  };
}
