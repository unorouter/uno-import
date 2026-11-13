import type { UniformEntry } from "../types/uniform-card";

// JanitorAI's lorebook entry shape, measured over 226 real entries. `probability`
// and `minMessages` are in every payload and were non-default in none of them,
// so they are read and dropped rather than modelled.
type JanitorEntry = {
  key?: unknown;
  keysecondary?: unknown;
  // CCv2 spelling, used by chub and by any character_book embedded in a card.
  // JanitorAI uses the singular; both otherwise carry the same fields.
  keys?: unknown;
  secondary_keys?: unknown;
  content?: string;
  comment?: string;
  name?: string;
  enabled?: boolean;
  constant?: boolean;
  selectiveLogic?: number;
  priority?: number;
  insertion_order?: number;
  matchWholeWords?: boolean;
};

// Some books store a key list as one comma separated string.
function keyList(...sources: unknown[]): string[] {
  for (const v of sources) {
    const list = Array.isArray(v)
      ? v
      : typeof v === "string"
        ? v.split(",")
        : null;
    if (!list) continue;
    const keys = list
      .filter((k): k is string => typeof k === "string")
      .map((k) => k.trim())
      .filter(Boolean);
    if (keys.length > 0) return keys;
  }
  return [];
}

// Shared by both adapters: datacat serves this array inline, JanitorAI serves the
// same array from /hampter/script/{id}, so one parser covers both.
export function toEntries(raw: string): UniformEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: UniformEntry[] = [];
  parsed.forEach((e: JanitorEntry, i) => {
    const keys = keyList(e.key, e.keys);
    const secondary = keyList(e.keysecondary, e.secondary_keys);
    // A keyless entry never matches unless it is always-on, so it would import
    // as dead weight.
    if (!e.content) return;
    if (keys.length === 0 && !e.constant) return;

    out.push({
      keys,
      secondaryKeys: secondary.length > 0 ? secondary : undefined,
      content: e.content,
      comment: e.comment || e.name || undefined,
      enabled: e.enabled !== false,
      constant: !!e.constant,
      selective: !!e.selectiveLogic,
      priority: typeof e.priority === "number" ? e.priority : 100,
      orderIndex: typeof e.insertion_order === "number" ? e.insertion_order : i,
      matchWholeWords: !!e.matchWholeWords,
    });
  });
  return out;
}
