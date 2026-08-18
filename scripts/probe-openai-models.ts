/**
 * Is a GPT model safe to measure with — before a project is pointed at it?
 *
 * The registry comment on openaiWebSearch says "verified live for gpt-4o /
 * gpt-4o-mini", and that is the whole problem with swapping models: OpenAI's
 * browse behaviour has historically varied by model AND by API surface
 * (Responses vs chat-completions, forced vs offered tool). A newer model can
 * reject the web_search_preview tool, spend the whole output budget on
 * reasoning, or answer fluently without searching — none of which throw on
 * their own. This sends the real requests and reports what actually happened.
 *
 *   npx tsx scripts/probe-openai-models.ts
 *   npx tsx scripts/probe-openai-models.ts --models gpt-5.6-sol,gpt-5.6-luna
 *   npx tsx scripts/probe-openai-models.ts --router concentrate
 *
 * Three probes per model:
 *   1. grounded  — runQuery with webSearch on: the EXACT monitored path
 *      (Responses API, forced tool_choice), on a question that can't be
 *      answered from memory. Passes only with sources AND a non-empty answer.
 *   2. offered   — the same Responses request with the tool merely offered, on
 *      a question the model knows cold. Diagnostic: shows whether forcing is
 *      still doing work on this model (it should search when forced even when
 *      it wouldn't on its own).
 *   3. ungrounded — runQuery with webSearch off: the chat-completions path a
 *      non-search project uses. Catches a model that rejects the params the
 *      adapter sends (e.g. a max-tokens field renamed out from under us).
 *
 * The direct key comes from $OPENAI_API_KEY or $TRIAL_OPENAI_API_KEY (or
 * --key-file <path>), never an argument. With --router, the router key comes
 * from $ROUTER_API_KEY_<ROUTER> / $ROUTER_API_KEY, same as probe-router.ts.
 * Costs a few small calls plus two real web searches per model, on that key.
 *
 * Use it before changing the OpenAI default in lib/models.ts, before pointing
 * a monitored project at a model the comment above hasn't named, or when
 * OpenAI ships a model family and you want to know what broke before the
 * trend lines tell you.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS } from "../lib/models";
import { ROUTERS, isRouterId, routerSlug, routerSupport } from "../lib/routers";
import { runQuery, humanError } from "../lib/llm";
import type { RouteInfo, RouterId } from "../lib/types";

/** Read .env.local into the environment, so a key set there is found without
 *  being exported by hand. Existing variables always win. */
function loadEnvLocal(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let raw = "";
  try {
    raw = readFileSync(resolve(repoRoot, ".env.local"), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (value && !process.env[m[1]]) process.env[m[1]] = value;
  }
}
loadEnvLocal();

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=");
      flags[name] = inline ?? argv[++i] ?? "";
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** The key, from a file or the environment — never from an argument, which
 *  would land in shell history and in `ps`. */
function readKey(router: RouterId | null, flags: Record<string, string>): string {
  if (flags["key-file"]) {
    const key = readFileSync(flags["key-file"], "utf8").trim();
    if (key) return key;
    throw new Error(`--key-file ${flags["key-file"]} is empty.`);
  }
  const names = router
    ? [`ROUTER_API_KEY_${router.toUpperCase()}`, "ROUTER_API_KEY"]
    : ["OPENAI_API_KEY", "TRIAL_OPENAI_API_KEY"];
  for (const name of names) {
    const key = process.env[name]?.trim();
    if (key) return key;
  }
  throw new Error(
    `No key. Set $${names.join(" (or $")}), or pass --key-file <path>. ` +
      "A key given as an argument would land in your shell history.",
  );
}

// A question that cannot be answered from training data — a sourceless reply is
// evidence the browse didn't happen, not evidence the model already knew. Same
// prompt probeRouterSearch uses, for the same reason.
const FRESH_PROMPT =
  "Search the web and tell me one news headline published in the last 48 hours. Cite the source URL.";
// A question the model knows cold. Searching on THIS is what proves the forcing
// lever works — left to choose, a model answers it from memory and cites nothing.
const MEMORY_PROMPT = "What is the capital of France?";

const ANSWER_MAX_TOKENS = 1200;

interface ProbeRow {
  model: string;
  probe: string;
  ok: boolean;
  detail: string;
}

/** The Responses request with the tool OFFERED rather than forced — not a
 *  production path, so it's built here rather than imported: the diagnostic
 *  contrast against the forced call, on the same surface. */
async function offeredProbe(
  apiKey: string,
  model: string,
  route: { baseUrl: string; slug: string } | null,
): Promise<{ sources: number; text: string; tokens: number }> {
  const url = route ? `${route.baseUrl}/responses` : "https://api.openai.com/v1/responses";
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: route ? route.slug : model,
      tools: [{ type: "web_search_preview" }],
      input: MEMORY_PROMPT,
      max_output_tokens: ANSWER_MAX_TOKENS,
    }),
  });
  const j = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    output?: { content?: { text?: string; annotations?: { url?: string }[] }[] }[];
    usage?: { total_tokens?: number };
  };
  if (!res.ok) throw new Error(j.error?.message ?? `HTTP ${res.status}`);
  let text = "";
  let sources = 0;
  for (const item of j.output ?? []) {
    for (const c of item.content ?? []) {
      if (typeof c.text === "string") text += c.text;
      sources += (c.annotations ?? []).filter((a) => a?.url).length;
    }
  }
  return { sources, text: text.trim(), tokens: j.usage?.total_tokens ?? 0 };
}

async function probeModel(
  model: string,
  apiKey: string,
  route: RouteInfo | null,
): Promise<ProbeRow[]> {
  const rows: ProbeRow[] = [];
  const base = { provider: "openai" as const, model, apiKey, route };

  // 1. The monitored grounded path, exactly as a run sends it.
  try {
    const r = await runQuery({ ...base, prompt: FRESH_PROMPT, webSearch: true });
    const empty = r.text.length === 0;
    rows.push({
      model,
      probe: "grounded (forced, production path)",
      ok: r.sources.length > 0 && !empty,
      detail: empty
        ? `EMPTY ANSWER with ${r.sources.length} sources, ${r.tokens} tokens — would be stored and scanned for zero mentions`
        : r.sources.length > 0
          ? `${r.sources.length} sources, ${r.text.length} chars, ${r.tokens} tokens`
          : `NO SOURCES (${r.text.length} chars, ${r.tokens} tokens) — ungrounded answer would be recorded as grounded`,
    });
  } catch (err) {
    rows.push({ model, probe: "grounded (forced, production path)", ok: false, detail: humanError(err) });
  }

  // 2. The forcing contrast: offered-only, on a memory-answerable question.
  try {
    const routed =
      route && routerSupport(route.router, "openai")?.shape === "openai-responses"
        ? {
            baseUrl: route.baseUrl?.trim() || ROUTERS[route.router].openaiBaseUrl,
            slug: routerSlug(route.router, "openai", model)!,
          }
        : null;
    const r = await offeredProbe(apiKey, model, routed);
    rows.push({
      model,
      probe: "offered (diagnostic contrast)",
      ok: true,
      detail: `${r.sources} sources on a memory-answerable question, ${r.tokens} tokens — ${
        r.sources > 0 ? "searches even unforced" : "answers from memory unless forced (forcing is load-bearing)"
      }`,
    });
  } catch (err) {
    // Diagnostic only, but a hard rejection here still matters: it usually means
    // the tool TYPE is wrong for this model, which the forced probe would have
    // reported less legibly.
    rows.push({ model, probe: "offered (diagnostic contrast)", ok: false, detail: humanError(err) });
  }

  // 3. The ungrounded path a non-search project uses.
  try {
    const r = await runQuery({ ...base, prompt: MEMORY_PROMPT, webSearch: false });
    rows.push({
      model,
      probe: "ungrounded (chat-completions path)",
      ok: r.text.length > 0,
      detail: r.text.length > 0 ? `${r.text.length} chars, ${r.tokens} tokens` : "EMPTY ANSWER",
    });
  } catch (err) {
    rows.push({ model, probe: "ungrounded (chat-completions path)", ok: false, detail: humanError(err) });
  }

  return rows;
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));

  const router: RouterId | null = flags.router
    ? isRouterId(flags.router)
      ? flags.router
      : (() => {
          throw new Error(`Unknown router "${flags.router}". Supported: ${Object.keys(ROUTERS).join(", ")}.`);
        })()
    : null;
  const route: RouteInfo | null = router ? { router, baseUrl: flags["base-url"] || null } : null;
  const apiKey = readKey(router, flags);

  // Default to the catalog's current default plus the 5.6 pair — the cut-over
  // this script exists to gather evidence for.
  const models = (flags.models || "gpt-4o,gpt-5.6-sol,gpt-5.6-luna")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const catalog = new Set(PROVIDERS.openai.models.map((m) => m.id));
  for (const m of models) {
    if (!catalog.has(m)) {
      console.warn(`note: ${m} is not in the lib/models.ts catalog — probing it anyway.\n`);
    }
  }

  console.log(
    `Probing OpenAI ${route ? `through ${ROUTERS[route.router].label}` : "directly"}: ${models.join(", ")}\n`,
  );

  let anyFailed = false;
  for (const model of models) {
    const rows = await probeModel(model, apiKey, route);
    console.log(`${model}`);
    for (const row of rows) {
      if (!row.ok) anyFailed = true;
      console.log(`  ${row.ok ? "PASS" : "FAIL"}  ${row.probe}: ${row.detail}`);
    }
    console.log("");
  }

  if (anyFailed) {
    console.log(
      "A model that fails the grounded or ungrounded probe must not be offered for that path:\n" +
        "the failure modes above don't throw in production — they get stored as measurements.",
    );
  }
  // Exits 0 either way, same as probe-router.ts: "this model can't do that" is a
  // successful probe, and a non-zero exit would make it look like a broken run.
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
