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
  kind?: "character";
  source: string;
  sourceUrl: string;
  card: { spec: string; spec_version?: string; data: Record<string, unknown> };
  lorebooks: UniformLorebook[];
  skipped: SkippedLorebook[];
};

// The user's own profile rather than a character. Only LoreBary publishes these;
// every other site treats a persona as private account data.
export type UniformPersona = {
  name: string;
  description: string;
  // Free-form and source-specific (archetype, gender, pronouns, age, traits).
  // Kept so the importer can compose a description without this file having to
  // know which fields each site invents.
  attributes?: Record<string, string>;
};

// An asset shipped inside a bundle. Bytes are base64 because passing binary out
// of page.evaluate any other way means a JSON array of a million numbers.
export type UniformAsset = {
  name: string;
  mimeType: string;
  base64: string;
};

// One shape per entity, discriminated so a single queue and a single poll route
// serve them all. `character` carries no `kind` for compatibility with the
// results unorouter already reads.
export type ImportResult =
  | UniformCard
  | {
      kind: "lorebook";
      source: string;
      sourceUrl: string;
      lorebooks: UniformLorebook[];
      skipped: SkippedLorebook[];
    }
  | {
      kind: "persona";
      source: string;
      sourceUrl: string;
      personas: UniformPersona[];
    }
  | {
      // A character that also ships lorebooks, scripts and assets. RisuRealm is
      // the only source that publishes all of it together; its actual "module"
      // format has zero published items, so this is what that support turned
      // out to mean in practice.
      kind: "rich-character";
      source: string;
      sourceUrl: string;
      card: { spec: string; spec_version?: string; data: Record<string, unknown> };
      lorebooks: UniformLorebook[];
      // RisuAI shapes, passed through untouched: unorouter already stores these
      // on a character and has parsers for both.
      regexScripts?: unknown;
      triggers?: unknown;
      assets: UniformAsset[];
    };
