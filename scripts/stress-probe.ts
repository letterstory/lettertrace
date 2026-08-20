/**
 * Prompt-shape stress test (design doc Q2).
 *
 * Validates the prompt-generation rules across brand AUTHORITY and product
 * type instead of the single stealth-stage brand the current rules were
 * measured on. Fixed question shapes — the same wording for every brand, only
 * the category/niche substituted — are asked across providers, and the
 * mention rate is reported by shape × authority × tier. No Supabase writes;
 * only API tokens are spent.
 *
 * The two findings this exists to produce:
 *   1. Which question SHAPES actually get companies named, per provider,
 *      across 20+ brands (does the "two-thirds must demand names" rule hold?).
 *   2. Whether the specificity ladder is real: established brands should hit
 *      on general questions, young brands only on niche ones. This calibrates
 *      the default tier mix per authority level.
 *
 *   npx tsx scripts/stress-probe.ts --dry            # print the grid + cost, no calls
 *   npx tsx scripts/stress-probe.ts                  # full run (anthropic + openai)
 *   npx tsx scripts/stress-probe.ts --authority young --providers anthropic
 *   npx tsx scripts/stress-probe.ts --brands stripe,linear,unkey
 *
 * Reads TRIAL_* keys from .env.local, like pilot-client.ts.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runQuery, humanError } from "../lib/llm";
import { detectMention, brandTerms } from "../lib/mentions";
import type { Provider } from "../lib/types";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function loadEnvLocal(): void {
  const raw = readFileSync(resolve(repoRoot, ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (value && !process.env[m[1]]) process.env[m[1]] = value;
  }
}

// --- fixtures --------------------------------------------------------------

type Authority = "established" | "growth" | "young";

interface BrandFixture {
  key: string;
  brandName: string;
  aliases: string[];
  authority: Authority;
  /** The broad category, phrased the way a buyer would ("payroll software"). */
  category: string;
  /** A narrow buyer situation where this brand realistically gets named. */
  niche: string;
}

// 21 brands, 7 per authority level, spread across product types. Authority is
// a judgment call frozen here so runs are comparable over time; revise the
// list, not individual runs.
const BRANDS: BrandFixture[] = [
  // --- established: category leaders any model has seen thousands of times
  { key: "stripe", brandName: "Stripe", aliases: [], authority: "established", category: "online payments infrastructure", niche: "accepting marketplace payments with split payouts as a small platform" },
  { key: "shopify", brandName: "Shopify", aliases: [], authority: "established", category: "ecommerce platforms", niche: "selling handmade goods online while syncing inventory to Instagram" },
  { key: "notion", brandName: "Notion", aliases: [], authority: "established", category: "team documentation and wiki tools", niche: "a lightweight wiki for a 10-person remote startup" },
  { key: "datadog", brandName: "Datadog", aliases: [], authority: "established", category: "application monitoring and observability platforms", niche: "monitoring a small Kubernetes cluster on a startup budget" },
  { key: "hubspot", brandName: "HubSpot", aliases: [], authority: "established", category: "CRM software", niche: "a free CRM for a two-person founding team" },
  { key: "cloudflare", brandName: "Cloudflare", aliases: [], authority: "established", category: "CDN and web security services", niche: "protecting a hobby website from bot traffic for free" },
  { key: "figma", brandName: "Figma", aliases: [], authority: "established", category: "collaborative interface design tools", niche: "real-time UI design collaboration for a distributed product team" },

  // --- growth: well known in their niche, not yet default answers
  { key: "linear", brandName: "Linear", aliases: ["Linear.app"], authority: "growth", category: "issue tracking and project management tools for software teams", niche: "fast keyboard-driven issue tracking for a small engineering team" },
  { key: "vercel", brandName: "Vercel", aliases: [], authority: "growth", category: "frontend hosting and deployment platforms", niche: "deploying a Next.js app with a preview URL per pull request" },
  { key: "posthog", brandName: "PostHog", aliases: [], authority: "growth", category: "product analytics platforms", niche: "self-hostable product analytics with session replay for a startup" },
  { key: "retool", brandName: "Retool", aliases: [], authority: "growth", category: "internal tool builders", niche: "building an admin panel on top of a Postgres database quickly" },
  { key: "gusto", brandName: "Gusto", aliases: [], authority: "growth", category: "payroll software", niche: "payroll and benefits for a 20-person US startup" },
  { key: "webflow", brandName: "Webflow", aliases: [], authority: "growth", category: "no-code website builders", niche: "building a marketing site with CMS collections without writing code" },
  { key: "supabase", brandName: "Supabase", aliases: [], authority: "growth", category: "backend-as-a-service platforms", niche: "an open-source Firebase alternative built on Postgres" },

  // --- young: the customers Lettertrace is for — findable only where niche
  { key: "runlayer", brandName: "Runlayer", aliases: [], authority: "young", category: "MCP security platforms", niche: "securing MCP servers for enterprise AI agent deployments" },
  { key: "resend", brandName: "Resend", aliases: [], authority: "young", category: "transactional email APIs", niche: "sending transactional email from a Next.js app with React email templates" },
  { key: "calcom", brandName: "Cal.com", aliases: ["Cal com", "Calcom"], authority: "young", category: "scheduling tools", niche: "an open-source Calendly alternative that can be self-hosted" },
  { key: "infisical", brandName: "Infisical", aliases: [], authority: "young", category: "secrets management tools", niche: "open-source secrets management for a small dev team" },
  { key: "triggerdev", brandName: "Trigger.dev", aliases: ["Trigger dev"], authority: "young", category: "background job frameworks", niche: "long-running background jobs in a serverless Next.js app" },
  { key: "documenso", brandName: "Documenso", aliases: [], authority: "young", category: "electronic signature tools", niche: "an open-source DocuSign alternative" },
  { key: "unkey", brandName: "Unkey", aliases: [], authority: "young", category: "API key management services", niche: "issuing and rate-limiting API keys for a public API" },
];

// --- shapes ----------------------------------------------------------------

type ShapeTier = "general" | "niche";

interface Shape {
  key: string;
  tier: ShapeTier;
  build: (b: BrandFixture) => string;
}

// Fixed wording, category/niche substituted — the shape is the variable under
// test, so it must not vary per brand. "how-to-choose" is the deliberate
// control: the measured expectation is ~0 names, and if it scores well the
// original single-brand finding didn't generalize.
const SHAPES: Shape[] = [
  { key: "list-top5", tier: "general", build: (b) => `List the top 5 companies for ${b.category}, by name.` },
  { key: "name-vendors", tier: "general", build: (b) => `Name the specific vendors that offer ${b.category}.` },
  { key: "main-players", tier: "general", build: (b) => `Who are the main players in ${b.category}?` },
  { key: "how-to-choose", tier: "general", build: (b) => `How do I choose ${b.category}?` },
  { key: "list-niche", tier: "niche", build: (b) => `List the companies to consider for ${b.niche}, by name.` },
  { key: "best-niche", tier: "niche", build: (b) => `What's the best option for ${b.niche}? Just company names.` },
  { key: "buyer-niche", tier: "niche", build: (b) => `What should I use for ${b.niche}?` },
];

// --- args ------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const providers = flag("providers", "anthropic,openai")
  .split(",")
  .map((p) => p.trim())
  .filter(
    (p): p is Provider =>
      p === "anthropic" || p === "openai" || p === "google" || p === "perplexity",
  );
const brandFilter = flag("brands", "").split(",").map((b) => b.trim()).filter(Boolean);
const authorityFilter = flag("authority", "").split(",").map((a) => a.trim()).filter(Boolean);
const shapeFilter = flag("shapes", "").split(",").map((s) => s.trim()).filter(Boolean);
const webSearch = flag("web-search", "on") !== "off";
const dry = has("dry");

const ANSWER_MODEL: Record<Provider, string> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-4o",
  google: "gemini-pro-latest",
  perplexity: "sonar-pro",
};

// Rough blended $/1M tokens, only for the --dry cost preview.
const BLENDED_COST_PER_MTOK: Record<Provider, number> = {
  anthropic: 10,
  openai: 7,
  google: 5,
  perplexity: 6,
};
const ROUGH_TOKENS_PER_QUERY = 1500;

const CONCURRENCY = 4;

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

// --- run -------------------------------------------------------------------

interface Probe {
  brand: string;
  authority: Authority;
  shape: string;
  tier: ShapeTier;
  provider: Provider;
  prompt: string;
}

interface ProbeOutcome extends Probe {
  ok: boolean;
  error?: string;
  mentioned: boolean;
  mentionCount: number;
  /** 0 = very start of the answer, 1 = very end. -1 when absent. */
  position: number;
  answerChars: number;
  tokens: number;
}

function pct(n: number, d: number): string {
  return d === 0 ? " n/a" : `${String(Math.round((n / d) * 100)).padStart(3)}%`;
}

async function main(): Promise<void> {
  loadEnvLocal();

  const brands = BRANDS.filter(
    (b) =>
      (brandFilter.length === 0 || brandFilter.includes(b.key)) &&
      (authorityFilter.length === 0 || authorityFilter.includes(b.authority)),
  );
  const shapes = SHAPES.filter(
    (s) => shapeFilter.length === 0 || shapeFilter.includes(s.key),
  );

  const probes: Probe[] = [];
  for (const b of brands) {
    for (const s of shapes) {
      for (const provider of providers) {
        probes.push({
          brand: b.key,
          authority: b.authority,
          shape: s.key,
          tier: s.tier,
          provider,
          prompt: s.build(b),
        });
      }
    }
  }

  const estTokens = probes.length * ROUGH_TOKENS_PER_QUERY;
  const estUsd = providers.reduce((sum, p) => {
    const share = probes.filter((x) => x.provider === p).length * ROUGH_TOKENS_PER_QUERY;
    return sum + (share / 1_000_000) * BLENDED_COST_PER_MTOK[p];
  }, 0);
  console.log(
    `${probes.length} probes: ${brands.length} brands x ${shapes.length} shapes x ${providers.length} provider(s)` +
      ` — rough estimate ~${Math.round(estTokens / 1000)}k tokens, ~$${estUsd.toFixed(2)}`,
  );

  if (dry) {
    for (const b of brands) {
      console.log(`\n${b.brandName} [${b.authority}]`);
      for (const s of shapes) console.log(`  (${s.tier}) ${s.build(b)}`);
    }
    console.log("\n--dry: no queries sent.");
    return;
  }

  const byKey = new Map(BRANDS.map((b) => [b.key, b]));
  let done = 0;
  const outcomes = await mapPool(probes, CONCURRENCY, async (probe): Promise<ProbeOutcome> => {
    const fixture = byKey.get(probe.brand)!;
    const base: ProbeOutcome = {
      ...probe,
      ok: false,
      mentioned: false,
      mentionCount: 0,
      position: -1,
      answerChars: 0,
      tokens: 0,
    };
    let out: ProbeOutcome;
    try {
      const res = await runQuery({
        provider: probe.provider,
        model: ANSWER_MODEL[probe.provider],
        apiKey: keyFor(probe.provider),
        prompt: probe.prompt,
        webSearch,
      });
      const hit = detectMention(res.text, brandTerms(fixture.brandName, fixture.aliases));
      out = {
        ...base,
        ok: true,
        mentioned: hit.mentioned,
        mentionCount: hit.count,
        position: hit.firstPosition,
        answerChars: res.text.length,
        tokens: res.tokens,
      };
    } catch (err) {
      out = { ...base, error: humanError(err) };
    }
    done++;
    const mark = !out.ok ? "ERR " : out.mentioned ? "HIT " : "miss";
    console.log(
      `[${String(done).padStart(3)}/${probes.length}] ${mark} ${probe.brand.padEnd(10)} ${probe.shape.padEnd(13)} (${probe.provider})`,
    );
    if (out.error) console.log(`        ${out.error}`);
    return out;
  });

  report(outcomes, brands, shapes);

  const outDir = resolve(here, "out");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = resolve(outDir, `stress-${stamp}.json`);
  writeFileSync(
    file,
    JSON.stringify({ providers, webSearch, brands, shapes: shapes.map((s) => s.key), outcomes }, null, 2),
  );
  console.log(`\ntranscript: ${file}`);
}

function report(outcomes: ProbeOutcome[], brands: BrandFixture[], shapes: Shape[]): void {
  const ok = outcomes.filter((o) => o.ok);
  const errs = outcomes.length - ok.length;
  console.log(
    `\n=== ${ok.length}/${outcomes.length} probes answered${errs ? ` (${errs} errors)` : ""} ===`,
  );

  // 1. Mention rate by shape — does the "demand names" rule generalize?
  console.log("\nMention rate by shape (all brands):");
  for (const s of shapes) {
    const sub = ok.filter((o) => o.shape === s.key);
    const hits = sub.filter((o) => o.mentioned).length;
    const perProvider = providers
      .map((p) => {
        const ps = sub.filter((o) => o.provider === p);
        return `${p} ${pct(ps.filter((o) => o.mentioned).length, ps.length)}`;
      })
      .join("  ");
    console.log(
      `  ${s.key.padEnd(13)} (${s.tier.padEnd(7)}) ${pct(hits, sub.length)}   ${perProvider}`,
    );
  }

  // 2. Authority x tier — the ladder validation. The expected picture:
  //    established brands hit both columns, young brands only the niche one.
  console.log("\nMention rate by authority x shape tier:");
  console.log(`  ${"".padEnd(12)} general   niche`);
  for (const auth of ["established", "growth", "young"] as Authority[]) {
    const sub = ok.filter((o) => o.authority === auth);
    if (!sub.length) continue;
    const cell = (tier: ShapeTier) => {
      const t = sub.filter((o) => o.tier === tier);
      return pct(t.filter((o) => o.mentioned).length, t.length);
    };
    console.log(`  ${auth.padEnd(12)} ${cell("general")}      ${cell("niche")}`);
  }

  // 3. Per brand — general vs niche rate, so single outliers are visible.
  console.log("\nPer brand (general | niche):");
  for (const b of brands) {
    const sub = ok.filter((o) => o.brand === b.key);
    if (!sub.length) continue;
    const rate = (tier: ShapeTier) => {
      const t = sub.filter((o) => o.tier === tier);
      return pct(t.filter((o) => o.mentioned).length, t.length);
    };
    console.log(
      `  ${b.brandName.padEnd(12)} [${b.authority.padEnd(11)}] ${rate("general")} | ${rate("niche")}`,
    );
  }
}

main().catch((err) => {
  console.error(humanError(err));
  process.exit(1);
});
