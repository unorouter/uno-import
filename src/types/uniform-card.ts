// The one shape every source normalises to. Fields were chosen against 226 real
// JanitorAI lorebook entries so each maps 1:1 onto a column unorouter's local
// schema already has, which is what keeps importing a card migration-free.

export type UniformEntry = {
  keys: string[];
  secondaryKeys?: string[];
  content: string;
  comment?: string;
  enabled: boolean;
  constant: boolean;
  selective: boolean;
  priority: number;
  orderIndex: number;
  matchWholeWords: boolean;
};

export type UniformLorebook = {
  name: string;
  scanDepth?: number;
  entries: UniformEntry[];
};

// A lorebook the source lists but will not hand over. Carrying the title turns a
// silent no-op into something the UI can name, and the two reasons are
// genuinely different: "private" is a live book the author withheld,
// "not_found" is one the API denies exists.
export type SkippedLorebook = {
  title: string;
  reason: "private" | "not_found";
};

export type UniformCard = {
  source: string;
  sourceUrl: string;
  card: { spec: string; spec_version?: string; data: Record<string, unknown> };
  lorebooks: UniformLorebook[];
  skipped: SkippedLorebook[];
};
