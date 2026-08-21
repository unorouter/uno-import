import type { UniformEntry } from "../types/uniform-card";

// JanitorAI's lorebook entry shape, measured over 226 real entries. `probability`
// and `minMessages` are in every payload and were non-default in none of them,
// so they are read and dropped rather than modelled.
type JanitorEntry = {
  key?: string[];
  keysecondary?: string[];
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
    const keys = Array.isArray(e.key) ? e.key.filter(Boolean) : [];
    // A keyless entry never matches unless it is always-on, so it would import
    // as dead weight.
    if (!e.content) return;
    if (keys.length === 0 && !e.constant) return;

    out.push({
      keys,
      secondaryKeys: e.keysecondary?.length ? e.keysecondary : undefined,
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
