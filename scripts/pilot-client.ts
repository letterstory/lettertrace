/**
 * Client pilot harness.
 *
 * Drives the real Lettertrace pipeline — scrape → suggest topics/prompts →
 * suggest competitors → query the answer engine → detect mentions → classify
 * sentiment — against a live brand, without writing anything to Supabase.
 *
 * It calls the same lib/ functions the product does, so what it reports is what
 * a real run would store. The point is to see which prompt shapes actually
 * surface a brand before committing a client to a monitoring config.
 *
 *   npx tsx scripts/pilot-client.ts cloudflare
 *   npx tsx scripts/pilot-client.ts runlayer --providers anthropic
 *   npx tsx scripts/pilot-client.ts all --max-prompts 6
 *
 * Reads TRIAL_ANTHROPIC_API_KEY / TRIAL_OPENAI_API_KEY from .env.local.
 * Writes a JSON transcript next to the summary it prints.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { scrapeDomain } from "../lib/scrape";
import {
  runQuery,
  analyzeResponse,
  suggestFromSite,
  suggestCompetitors,
  humanError,
  type CitedSource,
  type CompetitorSuggestion,
} from "../lib/llm";
import { detectMention, brandTerms } from "../lib/mentions";
import { hostOf, isOwnedDomain } from "../lib/engine";
import type { Provider } from "../lib/types";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// --- env ------------------------------------------------------------------

function loadEnvLocal(): void {
  const raw = readFileSync(resolve(repoRoot, ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (value && !process.env[m[1]]) process.env[m[1]] = value;
  }
}

// --- client fixtures ------------------------------------------------------

interface ClientConfig {
  key: string;
  brandName: string;
  /** index 0 is the primary domain; the rest are phantom sites. */
  brandDomains: string[];
  brandAliases: string[];
  /** Used only when the site can't be scraped (bot walls, JS-only pages). */
  fallbackDescription: string;
}

const CLIENTS: ClientConfig[] = [
  {
    key: "cloudflare",
    brandName: "Cloudflare",
    brandDomains: ["cloudflare.com"],
    brandAliases: [],
    fallbackDescription:
      "Cloudflare is a global network providing CDN, DDoS protection, DNS, zero-trust security, and edge compute (Workers) for websites and applications.",
  },
  {
    key: "runlayer",
    brandName: "Runlayer",
    brandDomains: ["runlayer.com"],
    brandAliases: [],
    fallbackDescription:
      "Runlayer is an MCP (Model Context Protocol) security platform providing an MCP gateway with real-time threat detection, fine-grained identity-based permissions, and observability for enterprise AI agent deployments.",
  },
];

// --- args -----------------------------------------------------------------

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const which = positional[0] ?? "all";
const maxPrompts = Number(flag("max-prompts", "10"));
const providers = flag("providers", "anthropic,openai")
  .split(",")
  .map((p) => p.trim())
  .filter(
    (p): p is Provider =>
      p === "anthropic" || p === "openai" || p === "google" || p === "perplexity",
  );
const webSearch = flag("web-search", "on") !== "off";

// Answer models: the flagship of each provider, i.e. what a real user asking
// ChatGPT or Claude would hit. Sentiment classification runs on the cheap model
// regardless (see analysisModelFor).
const ANSWER_MODEL: Record<Provider, string> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-4o",
  google: "gemini-pro-latest",
  perplexity: "sonar-pro",
};

// Rough blended $/1M tokens, only for an order-of-magnitude spend estimate.
const BLENDED_COST_PER_MTOK: Record<Provider, number> = {
  anthropic: 10,
  openai: 7,
  google: 5,
  // Perplexity bills per request and per search on top of tokens; this is only
  // an order-of-magnitude figure for the pilot's spend estimate.
  perplexity: 6,
};

// --- concurrency ----------------------------------------------------------

const CONCURRENCY = 3;

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// --- result shapes --------------------------------------------------------

interface PromptOutcome {
  topic: string;
  prompt: string;
  provider: Provider;
  model: string;
  ok: boolean;
  error?: string;
  answerChars: number;
  brandMentioned: boolean;
  brandCount: number;
  /** 0 = very start of the answer, 1 = very end. -1 when absent. */
  brandPosition: number;
  brandSentiment?: string;
  brandRecommended?: boolean;
  competitorsFound: string[];
  sources: { domain: string; owned: boolean }[];
  ownedSourceCited: boolean;
  tokens: number;
}

interface ClientReport {
  client: string;
  brandName: string;
  brandDomains: string[];
  description: string;
  scraped: boolean;
  topics: { name: string; prompts: string[] }[];
  competitors: CompetitorSuggestion[];
  outcomes: PromptOutcome[];
  tokensUsed: number;
}

// --- pipeline -------------------------------------------------------------

function keyFor(provider: Provider): string {
  const env: Record<Provider, string> = {
    anthropic: "TRIAL_ANTHROPIC_API_KEY",
    openai: "TRIAL_OPENAI_API_KEY",
    google: "TRIAL_GOOGLE_API_KEY",
    perplexity: "TRIAL_PERPLEXITY_API_KEY",
  };
  const k = process.env[env[provider]];
  if (!k) throw new Error(`Missing ${env[provider]} in .env.local`);
  return k;
}

async function buildConfig(
  client: ClientConfig,
  setupProvider: Provider,
): Promise<Pick<ClientReport, "description" | "scraped" | "topics" | "competitors"> & { tokens: number }> {
  const apiKey = keyFor(setupProvider);
  const model = ANSWER_MODEL[setupProvider];
  let tokens = 0;

  // 1. Scrape the primary domain (same path onboarding uses).
  const primary = client.brandDomains[0];
  let siteText = "";
  let scraped = false;
  try {
    const res = await scrapeDomain(primary);
    const text = res.text ?? "";
    if (res.ok && text.trim().length > 200) {
      siteText = text;
      scraped = true;
    }
  } catch {
    /* fall through to the description fallback */
  }
  if (!scraped) siteText = client.fallbackDescription;
  console.log(
    `  scrape ${primary}: ${scraped ? `${siteText.length} chars` : "FAILED — using fallback description"}`,
  );

  // 2. Infer description + topics + prompts from the site.
  const suggestion = await suggestFromSite({
    provider: setupProvider,
    model,
    apiKey,
    brandName: client.brandName,
    siteText,
  });
  tokens += suggestion.tokens;
  const description = suggestion.description || client.fallbackDescription;
  console.log(`  description: ${description}`);
  console.log(
    `  topics: ${suggestion.topics.length} (${suggestion.topics.reduce((n, t) => n + t.prompts.length, 0)} prompts)`,
  );

  // 3. Suggest competitors.
  const comp = await suggestCompetitors({
    provider: setupProvider,
    model,
    apiKey,
    brandName: client.brandName,
    brandDomain: primary,
    description,
    topics: suggestion.topics.map((t) => t.name),
    existing: [],
    count: 8,
  });
  tokens += comp.tokens;
  console.log(`  competitors: ${comp.suggestions.map((c) => c.name).join(", ") || "(none)"}`);

  return { description, scraped, topics: suggestion.topics, competitors: comp.suggestions, tokens };
}

async function runPrompt(
  client: ClientConfig,
  competitors: CompetitorSuggestion[],
  topic: string,
  prompt: string,
  provider: Provider,
): Promise<PromptOutcome> {
  const apiKey = keyFor(provider);
  const model = ANSWER_MODEL[provider];
  const bTerms = brandTerms(client.brandName, client.brandAliases);
  const ownedHosts = client.brandDomains.map(hostOf).filter(Boolean);

  const base: PromptOutcome = {
    topic,
    prompt,
    provider,
    model,
    ok: false,
    answerChars: 0,
    brandMentioned: false,
    brandCount: 0,
    brandPosition: -1,
    competitorsFound: [],
    sources: [],
    ownedSourceCited: false,
    tokens: 0,
  };

  let answer: string;
  let sources: CitedSource[];
  let tokens: number;
  try {
    const res = await runQuery({ provider, model, apiKey, prompt, webSearch });
    answer = res.text;
    sources = res.sources;
    tokens = res.tokens;
  } catch (err) {
    return { ...base, error: humanError(err) };
  }

  const brandHit = detectMention(answer, bTerms);
  const competitorsFound: string[] = [];
  for (const c of competitors) {
    if (detectMention(answer, [c.name, ...c.aliases]).mentioned) competitorsFound.push(c.name);
  }

  const sourceRows = sources.map((s) => ({
    domain: s.domain,
    owned: ownedHosts.some((h) => isOwnedDomain(s.domain, h)),
  }));

  let brandSentiment: string | undefined;
  let brandRecommended: boolean | undefined;
  if (brandHit.mentioned) {
    const analysis = await analyzeResponse({
      provider,
      model,
      apiKey,
      question: prompt,
      responseText: answer,
      entities: [{ key: "brand", name: client.brandName }],
    });
    tokens += analysis.tokens;
    const r = analysis.results.find((x) => x.key === "brand");
    brandSentiment = r?.sentiment;
    brandRecommended = r?.recommended;
  }

  return {
    ...base,
    ok: true,
    answerChars: answer.length,
    brandMentioned: brandHit.mentioned,
    brandCount: brandHit.count,
    brandPosition: brandHit.firstPosition,
    brandSentiment,
    brandRecommended,
    competitorsFound,
    sources: sourceRows,
    ownedSourceCited: sourceRows.some((s) => s.owned),
    tokens,
  };
}

async function runClient(client: ClientConfig): Promise<ClientReport> {
  console.log(`\n=== ${client.brandName} (${client.brandDomains[0]}) ===`);
  const setupProvider = providers[0];
  const config = await buildConfig(client, setupProvider);

  // Flatten topics → prompts, round-robin across topics so a cap still gives
  // topic variety rather than every prompt from the first topic.
  const flat: { topic: string; prompt: string }[] = [];
  const maxDepth = Math.max(0, ...config.topics.map((t) => t.prompts.length));
  for (let i = 0; i < maxDepth; i++) {
    for (const t of config.topics) {
      if (t.prompts[i]) flat.push({ topic: t.name, prompt: t.prompts[i] });
    }
  }
  const selected = flat.slice(0, maxPrompts);

  const jobs: { topic: string; prompt: string; provider: Provider }[] = [];
  for (const provider of providers) {
    for (const s of selected) jobs.push({ ...s, provider });
  }
  console.log(`  running ${jobs.length} queries (${selected.length} prompts x ${providers.length} provider(s))…`);

  let done = 0;
  const outcomes = await mapPool(jobs, CONCURRENCY, async (job) => {
    const out = await runPrompt(client, config.competitors, job.topic, job.prompt, job.provider);
    done++;
    const mark = !out.ok ? "ERR " : out.brandMentioned ? "HIT " : "miss";
    console.log(`  [${String(done).padStart(2)}/${jobs.length}] ${mark} (${job.provider}) ${job.prompt.slice(0, 72)}`);
    if (out.error) console.log(`         ${out.error}`);
    return out;
  });

  return {
    client: client.key,
    brandName: client.brandName,
    brandDomains: client.brandDomains,
    description: config.description,
    scraped: config.scraped,
    topics: config.topics,
    competitors: config.competitors,
    outcomes,
    tokensUsed: config.tokens + outcomes.reduce((n, o) => n + o.tokens, 0),
  };
}

// --- reporting ------------------------------------------------------------

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;
}

function summarize(report: ClientReport): void {
  const ok = report.outcomes.filter((o) => o.ok);
  const hits = ok.filter((o) => o.brandMentioned);
  console.log(`\n--- ${report.brandName}: ${hits.length}/${ok.length} answers mentioned the brand (${pct(hits.length, ok.length)}) ---`);

  for (const provider of providers) {
    const sub = ok.filter((o) => o.provider === provider);
    if (!sub.length) continue;
    const h = sub.filter((o) => o.brandMentioned);
    console.log(`  ${provider}: ${h.length}/${sub.length} (${pct(h.length, sub.length)})`);
  }

  // Share of voice: how often each competitor appeared vs the brand.
  const tally = new Map<string, number>();
  for (const o of ok) for (const c of o.competitorsFound) tally.set(c, (tally.get(c) ?? 0) + 1);
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`  brand appeared in ${hits.length}; top competitors:`);
  for (const [name, n] of ranked.slice(0, 8)) {
    console.log(`    ${String(n).padStart(3)}  ${name}`);
  }

  const withOwned = ok.filter((o) => o.ownedSourceCited);
  console.log(`  answers citing an owned domain: ${withOwned.length}/${ok.length}`);

  const errs = report.outcomes.filter((o) => !o.ok);
  if (errs.length) console.log(`  errors: ${errs.length}`);
}

async function main(): Promise<void> {
  loadEnvLocal();

  const targets =
    which === "all" ? CLIENTS : CLIENTS.filter((c) => c.key === which);
  if (!targets.length) {
    console.error(`Unknown client "${which}". Known: ${CLIENTS.map((c) => c.key).join(", ")}, all`);
    process.exit(1);
  }
  console.log(
    `providers=${providers.join(",")} webSearch=${webSearch} maxPrompts=${maxPrompts}`,
  );

  const reports: ClientReport[] = [];
  for (const client of targets) {
    reports.push(await runClient(client));
  }

  console.log("\n================ SUMMARY ================");
  let totalTokens = 0;
  for (const r of reports) {
    summarize(r);
    totalTokens += r.tokensUsed;
  }
  const est = reports.reduce((sum, r) => {
    const perProvider = r.outcomes.reduce(
      (n, o) => n + (o.tokens / 1_000_000) * BLENDED_COST_PER_MTOK[o.provider],
      0,
    );
    return sum + perProvider;
  }, 0);
  console.log(`\ntokens: ${totalTokens.toLocaleString()}  (~$${est.toFixed(2)} at blended rates)`);

  const outDir = process.env.PILOT_OUT_DIR ?? resolve(repoRoot, ".pilot");
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, `pilot-${which}-${Date.now()}.json`);
  writeFileSync(outFile, JSON.stringify(reports, null, 2));
  console.log(`transcript: ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
