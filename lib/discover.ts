// ------------------------------------------------------------------
// Finding the companies an answer named that the project doesn't track.
//
// Mention detection only looks for the brand and its listed competitors, so
// every other company an answer recommends is discarded. That makes a project
// with a mismatched competitor list indistinguishable from one whose prompts
// never asked for recommendations: both read as "named nobody". Observed live, a
// brand sat at 16% informative while its answers were full of vendors (Kore.ai,
// Boomi Agentstudio, Airia) that simply weren't on its list.
//
// The answers are already stored, so this needs no extra model call. It is
// deliberately a CANDIDATE generator: the user confirms each one before it
// becomes a tracked competitor, so recall matters more than perfect precision,
// and anything ambiguous is better dropped than guessed.
// ------------------------------------------------------------------

/** Markdown emphasis, headings and links are where these answers put names. */
const PATTERNS = [
  /\*\*([^*\n]{2,60})\*\*/g, // **Vendor**
  /^#{2,4}\s+(.{2,60})$/gm, // ## Vendor
  /\[([^\]\n]{2,60})\]\(https?:\/\//g, // [Vendor](https://…)
];

// Bold is also used for prose headings ("**1. Start with discovery.**",
// "**Why this matters**"), which is the dominant source of false positives.
const HEADING_STARTERS =
  /^(why|how|what|when|where|which|who|if|for|start|offer|use|choose|build|get|keep|make|set|add|enable|ensure|consider|note|important|pros|cons|best|top|summary|recommendation|bottom|key|tip|caveat|warning|option|step|first|second|third|finally|also|next|core|my take|tl;dr|in short|the )/i;

// A Title Case phrase ending in a plural category noun is a section heading, not
// a product: "AI-Specific Governance Platforms", "Architectural Options",
// "Core Best Practices", "MCP gateways/proxies". This one rule removes most of
// the remaining false positives without touching any real vendor name.
const CATEGORY_TAILS = new Set([
  "platforms", "options", "practices", "signals", "tiers", "gateways", "proxies",
  "providers", "tools", "solutions", "services", "systems", "alternatives",
  "approaches", "considerations", "recommendations", "controls", "capabilities",
  "features", "layers", "patterns", "types", "categories", "vendors", "players",
  "contenders", "choices", "picks", "steps", "basics", "tradeoffs", "caveats",
  "limitations", "benefits", "risks", "requirements", "metrics", "workloads",
  "agents", "benchmarks", "api", "apis", "sdks", "models", "frameworks",
]);

// Category nouns and acronyms that read like names but identify no company.
const GENERIC = new Set(
  [
    "api", "apis", "sdk", "cli", "mcp", "mcps", "oauth", "sso", "saas", "nfs", "smb",
    "posix", "ai", "llm", "llms", "hpc", "gpu", "gpus", "vpn", "iam", "siem", "casb",
    "dns", "cdn", "waf", "ddos", "rag", "etl", "cpu", "ssd", "hdd", "vm", "vms", "os",
    "ci/cd", "devops", "finops", "secops", "identity", "governance", "observability",
    "monitoring", "security", "compliance", "storage", "networking", "encryption",
    "authentication", "authorization", "audit", "logging", "caching", "cache",
    "serverless", "kubernetes", "docker", "linux", "windows", "macos",
    // Single-word section headings seen in real answers.
    "cost", "costs", "pricing", "performance", "latency", "throughput",
    "scalability", "reliability", "availability", "analytics", "dnssec",
    "access control", "anomaly detection", "data governance",
      "certifications", "cloud-native", "cloud iam", "node-local nvme",
    "baseline", "benchmarks",
  ].map((s) => s.toLowerCase()),
);

// The vocabulary of SECTION HEADINGS. A how-to answer structures itself with
// bold/`##` phrases like "Policy Enforcement Architecture", "Foundational
// Framework", "Multi-Layer Enforcement", "Key Implementation Steps" — every word
// abstract, none a name. The extractor treats those as candidate companies
// because they're Title Case, and no per-word rule catches them: each individual
// word is fine ("Policy", "Framework"), it's the ABSENCE of a distinctive token
// that gives them away. This set powers that "all words are generic" test below.
// Deliberately excludes anything that doubles as a real vendor's word (no
// "cloud", "identity" beyond GENERIC, no finance terms) — one distinctive token
// keeps a phrase, so "Ping Identity" and "Value Line" survive.
const ABSTRACT_TERMS = new Set(
  [
    "policy", "policies", "enforcement", "architecture", "architectural",
    "framework", "frameworks", "foundational", "foundation", "multi", "layer",
    "layered", "key", "implementation", "implementing", "approach", "approaches",
    "strategy", "strategies", "principle", "principles", "component", "mechanism",
    "phase", "consideration", "requirement", "capability", "feature", "benefit",
    "overview", "summary", "introduction", "conclusion", "recommendation",
    "decision", "defined", "authority", "runtime", "shared", "core", "essential",
    "essentials", "fundamentals", "advanced", "modern", "unified", "centralized",
    "distributed", "automated", "continuous", "comprehensive", "holistic",
    "robust", "scalable", "integrated", "structured", "general", "common",
    "standard", "guidelines", "guide", "process", "workflow", "lifecycle",
    "roadmap", "blueprint", "pillar", "section", "module", "stage", "level",
    "aspect", "dimension", "factor", "element", "scope", "context", "objective",
    "goal", "outcome", "plan", "design", "setup", "configuration", "deployment",
    "integration", "orchestration", "alignment", "adoption", "transformation",
    "optimization", "automation", "protection", "prevention", "detection",
    "response", "remediation", "mitigation", "isolation", "segmentation",
    "verification", "validation", "provisioning", "onboarding", "permission",
    "permissions", "role", "roles", "attribute", "attributes", "credential",
    "credentials", "rotation", "tracing", "telemetry", "reporting", "alerting",
  ].map((s) => s.toLowerCase()),
);

// Single bolded words are as often a defined term or a reporting verb as a
// company. Observed against a finance brand's answers, which bolded "Alpha",
// "Beta", "Measures" and "Reflects" while genuinely naming Bloomberg Terminal
// and FactSet. Only applied to one-word candidates, so "Deno Deploy" is safe.
const COMMON_SINGLE_WORDS = new Set([
  // Greek letters and statistics, which double as finance jargon.
  "alpha", "beta", "gamma", "delta", "sigma", "theta", "omega", "sharpe",
  "volatility", "correlation", "variance", "deviation", "median", "mean",
  "average", "ratio", "index", "benchmark", "yield", "return", "returns",
  "risk", "exposure", "duration", "momentum", "value", "growth", "quality",
  // Reporting verbs and connectives that get bolded mid-sentence.
  "measures", "reflects", "indicates", "includes", "requires", "provides",
  "means", "note", "caution", "example", "result", "results", "conclusion",
  "definition", "formula", "interpretation", "takeaway", "verdict", "answer",
  "yes", "no", "maybe", "always", "never", "however", "therefore",
]);

/** Lowercase words a real product name may contain. Kept to the ones actually
 *  observed in the model catalog, since each one weakens the heuristic. */
const LOWERCASE_CONNECTORS = new Set(["for"]);

/** Strip markdown leftovers and trailing punctuation from a captured span. */
function clean(raw: string): string {
  return raw
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?]+$/, "")
    .trim();
}

/**
 * Is this plausibly a company or product name rather than a sentence fragment?
 *
 * Tuned against real answers: the rejections below are each responsible for a
 * class of false positive seen in stored text, not hypothetical.
 */
export function looksLikeCompanyName(value: string): boolean {
  const name = value.trim();
  if (name.length < 2 || name.length > 40) return false;
  // Must open on a letter: kills "1. Start with discovery" and "**2024**".
  if (!/^[A-Za-z]/.test(name)) return false;
  // Sentence punctuation, list separators, or a mid-string full stop. Slashes
  // and spaced ampersands mark a phrase ("Authentication/authorization",
  // "Access & Identity Management"); no real vendor here needs them.
  if (/[?!:|/]|\s[—–]\s|\s&\s|\.\s/.test(name)) return false;
  // Comparison and arithmetic operators mean a defined quantity, not a company.
  // A finance brand's answers bolded "Beta < 1.0", "Beta = 0", "Beta > 1.0".
  if (/[<>=+×%]/.test(name)) return false;
  if (HEADING_STARTERS.test(name)) return false;
  // Conjunctions and pronouns mark a phrase, not a name: "Identity and
  // permissions", "what you should use". " for " is allowed on purpose —
  // "Amazon FSx for Lustre" and "Mountpoint for Amazon S3" are real products.
  if (/\b(and|or|to|your|you|their|our|its|a|an|is|are|be|of|in|on|with|without|vs)\b/i.test(name)) {
    return false;
  }
  const words = name.split(" ");
  if (words.length > 4) return false;
  // A name is capitalised. Requiring only the first word to be capitalised lets
  // through "Best practices"; requiring all of them rejects "Kore.ai". So:
  // first word capitalised, and no word that is purely lowercase letters —
  // except the connectors real product names genuinely contain, without which
  // "Amazon FSx for Lustre" and "Mountpoint for Amazon S3" get thrown away.
  if (!/^[A-Z]/.test(words[0])) return false;
  if (words.some((w) => /^[a-z]+$/.test(w) && !LOWERCASE_CONNECTORS.has(w))) return false;
  if (GENERIC.has(name.toLowerCase())) return false;
  if (words.length > 1 && CATEGORY_TAILS.has(words[words.length - 1].toLowerCase())) {
    return false;
  }
  if (words.length === 1 && COMMON_SINGLE_WORDS.has(name.toLowerCase())) return false;
  // A phrase whose EVERY token is an abstract/generic term is a section heading
  // or concept, not a company: "Policy Enforcement Architecture", "Foundational
  // Framework", "Multi-Layer Enforcement". Tokens split on spaces and hyphens; a
  // single distinctive word — which a real name almost always has ("Ping" in
  // "Ping Identity", "Bloomberg" in "Bloomberg Terminal") — keeps the phrase.
  const tokens = name.toLowerCase().split(/[\s-]+/).filter(Boolean);
  if (
    tokens.length > 0 &&
    tokens.every((t) => ABSTRACT_TERMS.has(t) || GENERIC.has(t) || CATEGORY_TAILS.has(t))
  ) {
    return false;
  }
  return true;
}

export interface DiscoveredCompany {
  name: string;
  /** Number of distinct answers that named it. */
  answers: number;
}

/** Candidate names in one answer, deduped case-insensitively. */
export function namesInAnswer(text: string): string[] {
  const found = new Map<string, string>();
  for (const pattern of PATTERNS) {
    // Patterns carry /g (and /m), so reset before reuse across calls.
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const name = clean(match[1] ?? "");
      if (!looksLikeCompanyName(name)) continue;
      const key = name.toLowerCase();
      if (!found.has(key)) found.set(key, name);
    }
  }
  return [...found.values()];
}

/**
 * Candidate names in one answer that AREN'T the brand, a tracked competitor, or
 * a product line of one — the untracked companies a single answer named. This
 * is what lets the run view say "these companies showed up and you don't track
 * them" instead of a flat "named nobody". `tracked` should carry the brand, its
 * aliases, and every tracked competitor's name and aliases.
 */
export function untrackedNamesInAnswer(text: string, tracked: string[]): string[] {
  const known = new Set(tracked.map((t) => t.trim().toLowerCase()).filter(Boolean));
  // A candidate that merely EXTENDS a tracked name is that company's own product
  // line, not a rival: "Cloudflare Workers" is Cloudflare.
  const extendsTracked = (key: string) =>
    [...known].some((t) => key.startsWith(`${t} `) || key.startsWith(`${t}(`));
  return namesInAnswer(text).filter((n) => {
    const key = n.toLowerCase();
    return !known.has(key) && !extendsTracked(key);
  });
}

/**
 * Companies named across these answers that aren't already accounted for.
 *
 * `tracked` should include the brand, its aliases, and every tracked
 * competitor's name and aliases: the point is to surface what is MISSING from
 * the list, so anything already on it is noise here.
 *
 * Ordered by how many answers named them, which is the signal that matters:
 * a name in ten answers is the category's default choice, while a spread of
 * names appearing once each means the models have no consensus at all.
 */
export function discoverCompanies(
  answers: string[],
  tracked: string[],
  options: { limit?: number } = {},
): DiscoveredCompany[] {
  const counts = new Map<string, { name: string; answers: number }>();

  for (const answer of answers) {
    // untrackedNamesInAnswer drops the brand, tracked competitors, and their
    // product lines — the shared filter both this rollup and the per-answer view
    // read from, so they can't disagree about what "untracked" means.
    for (const name of untrackedNamesInAnswer(answer || "", tracked)) {
      const key = name.toLowerCase();
      const row = counts.get(key) ?? { name, answers: 0 };
      row.answers++;
      counts.set(key, row);
    }
  }

  const out = [...counts.values()].sort(
    (a, b) => b.answers - a.answers || a.name.localeCompare(b.name),
  );
  return options.limit ? out.slice(0, options.limit) : out;
}
