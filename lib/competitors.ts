// ------------------------------------------------------------------
// Turning untrusted competitor input into rows we can insert.
//
// Two callers need the identical treatment and would otherwise drift apart:
// the model's suggestions during onboarding (lib/llm) and the onboarding
// request body itself (app/api/onboarding/complete), which a client can send
// without ever having asked for suggestions. Both must strip the brand itself
// and collapse repeats, because `competitors` carries a unique index on
// (project_id, name) and one duplicate aborts the whole batch insert.
// ------------------------------------------------------------------

export interface CompetitorInput {
  name: string;
  aliases: string[];
  domain: string | null;
}

/** Accepts an array of strings, or one comma-separated string, or nothing. */
function toAliases(value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value.map((a) => (typeof a === "string" ? a : ""))
    : typeof value === "string"
      ? value.split(",")
      : [];
  return parts.map((a) => a.trim()).filter((a) => a.length > 0);
}

/** One untrusted entry, trimmed. The name may still be empty — callers decide
 *  whether that's a reason to drop the row or to reject the request. */
export function normalizeCompetitor(value: unknown): CompetitorInput {
  const o = (value ?? {}) as Record<string, unknown>;
  return {
    name: typeof o.name === "string" ? o.name.trim() : "",
    aliases: toAliases(o.aliases),
    // Domains are compared against cited source hosts, which are lowercased.
    domain:
      typeof o.domain === "string" && o.domain.trim().length > 0
        ? o.domain.trim().toLowerCase()
        : null,
  };
}

/**
 * A whole list, ready to insert: unnamed rows dropped, `exclude` removed, and
 * repeats collapsed case-insensitively (first occurrence wins, so the entry
 * the user sees first is the one that survives).
 *
 * Unnamed rows are dropped rather than rejected: a competitor with no name
 * carries nothing else the user would lose, unlike a topic, so refusing an
 * entire submission over one blank row would be hostile.
 */
export function normalizeCompetitorList(
  value: unknown,
  options: { exclude?: string[]; limit?: number } = {},
): CompetitorInput[] {
  const blocked = new Set(
    (options.exclude ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean),
  );
  const seen = new Set<string>();

  const list = (Array.isArray(value) ? value : [])
    .map(normalizeCompetitor)
    .filter((c) => {
      const key = c.name.toLowerCase();
      if (!c.name || blocked.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return options.limit ? list.slice(0, options.limit) : list;
}
