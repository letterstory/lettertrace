/**
 * Does this router actually pass the provider's native web search through?
 *
 * The one question the router support table in lib/routers.ts can't answer from
 * documentation. A gateway will happily accept a request carrying Anthropic's
 * `web_search` tool and a forcing `tool_choice`, normalize them away, and return
 * a fluent sourceless answer — which Lettertrace would store and chart exactly
 * like a grounded one. Reading a router's docs tells you what it claims;
 * this sends the real request and counts the sources that come back.
 *
 *   npx tsx scripts/probe-router.ts openrouter
 *   npx tsx scripts/probe-router.ts concentrate --provider anthropic
 *
 * The key comes from $ROUTER_API_KEY (or --key-file <path>), never an argument.
 * Costs a few tokens plus one real web search per engine probed, on that key.
 *
 * Use it when adding a router, when raising a `search` entry from 'none' to
 * 'passthrough', or when a router changes its API and you want to know before
 * your users' trend lines tell you. The per-credential check that runs when a
 * user saves a key (verifyRouterKey) asks the same question — this is the
 * operator-side version, runnable without a database or a signed-in account.
 */

import { readFileSync } from "node:fs";
import { PROVIDERS, analysisModelFor } from "../lib/models";
import { ROUTERS, isRouterId, routerProviders, routerSupport } from "../lib/routers";
import { probeRouterSearch, humanError } from "../lib/llm";
import type { Provider, RouterId } from "../lib/types";

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

function readKey(flags: Record<string, string>): string {
  if (flags["key-file"]) {
    const key = readFileSync(flags["key-file"], "utf8").trim();
    if (key) return key;
    throw new Error(`--key-file ${flags["key-file"]} is empty.`);
  }
  const env = process.env.ROUTER_API_KEY?.trim();
  if (env) return env;
  throw new Error(
    "No key. Set $ROUTER_API_KEY or pass --key-file <path>. A key given as an argument would land in your shell history.",
  );
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const routerArg = positional[0];

  if (!routerArg || !isRouterId(routerArg)) {
    console.error(
      `Usage: npx tsx scripts/probe-router.ts <${Object.keys(ROUTERS).join("|")}> [--provider <p>] [--model <m>] [--base-url <u>] [--key-file <path>]`,
    );
    process.exit(2);
  }
  const router: RouterId = routerArg;
  const apiKey = readKey(flags);
  const baseUrl = flags["base-url"] || null;

  // Default to every engine the registry says this router serves; --provider
  // narrows it, which is what you want when adding one entry at a time.
  const providers: Provider[] = flags.provider
    ? [flags.provider as Provider]
    : routerProviders(router);

  console.log(`Probing ${ROUTERS[router].label}${baseUrl ? ` at ${baseUrl}` : ""}\n`);

  let anyUngrounded = false;
  for (const provider of providers) {
    const support = routerSupport(router, provider);
    const label = PROVIDERS[provider]?.label ?? provider;
    if (!support) {
      console.log(`${label}: not served by this router (no entry in the registry).`);
      continue;
    }

    // The model matters: pinning it lets you check whether a slug the registry
    // guessed is the slug the router actually publishes.
    const model = flags.model || defaultProbeModel(provider);
    process.stdout.write(`${label} (${model}, search: ${support.search}) ... `);

    try {
      const { sources, text } = await probeRouterSearch(
        { router, baseUrl },
        provider,
        model,
        apiKey,
      );
      if (sources > 0) {
        console.log(`grounded — ${sources} source${sources === 1 ? "" : "s"} cited.`);
      } else {
        anyUngrounded = true;
        console.log("NO SOURCES. The answer came back ungrounded.");
        console.log(`  first 200 chars: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
      }
    } catch (err) {
      anyUngrounded = true;
      console.log(`failed — ${humanError(err)}`);
    }
  }

  if (anyUngrounded) {
    console.log(
      "\nAn engine that returns no sources must not be marked 'passthrough' in lib/routers.ts:\n" +
        "monitored runs would record memory answers as search-grounded measurements.",
    );
  }
  // Deliberately exits 0 either way: "this router strips grounding" is a
  // successful probe, and a non-zero exit would make it look like a broken run.
}

/** The provider's designated cheap model — the same one classification uses. The
 *  question is whether a search happens, not how well the model writes. */
function defaultProbeModel(provider: Provider): string {
  return analysisModelFor(provider);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
