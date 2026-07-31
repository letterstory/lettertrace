/**
 * Integration harness for LLM router credentials (`router_keys`, `runs.route`).
 *
 * The unit tests mock the database and the network. The probe script exercises
 * the provider calls but never touches Postgres. This does both against the real
 * thing: it runs the actual save path (verify → probe grounding → encrypt →
 * store), reads what landed in the database, resolves a run key the way a run
 * does, and then executes a real monitored run through the router and checks
 * that what was stored is a grounded measurement attributed to the right engine.
 *
 *   npx tsx scripts/harness-router-keys.ts
 *
 * Requires in .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * ENCRYPTION_KEY. The router key comes from $ROUTER_API_KEY or --key-file, never
 * an argument. Unlike the provider-key harness this needs no running server —
 * every path it exercises is library code.
 *
 * NOT part of `npm test`: it needs a live database and spends real tokens
 * (several small calls plus a handful of web searches).
 *
 * Everything is namespaced to one throwaway user deleted in a `finally`,
 * including when an assertion fails. The user id is printed at the start so a
 * crashed run can be cleaned up by hand.
 *
 * On secrets: the router key is held in memory and written only as ciphertext.
 * "no output ever contained the key" is an explicit assertion over every byte
 * this harness prints, not an assumption.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { decryptSecret } from "../lib/crypto";
import { routerProviders, routerSupport } from "../lib/routers";
import type { Project, Provider } from "../lib/types";

// lib/data wraps its readers in React's cache(), which only exists inside
// Next's runtime — importing it from a plain Node script throws before any
// assertion runs. The unit tests dodge this by mocking the whole module; a
// harness can't, since the point is to exercise the real reader. So stub cache()
// as identity (it is a per-request memo, and this process makes one pass), then
// pull in everything downstream of it dynamically so the stub lands first.
const nodeRequire = createRequire(import.meta.url);
const react = nodeRequire("react") as { cache?: <T>(fn: T) => T };
if (typeof react.cache !== "function") react.cache = (fn) => fn;

/** Pulled in once main() starts, so the stub above is installed first. */
async function loadLib() {
  return {
    ...(await import("../lib/router-keys")),
    ...(await import("../lib/data")),
    ...(await import("../lib/trial")),
    ...(await import("../lib/engine")),
  };
}

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
loadEnvLocal();

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env.local`);
  return v;
}

const SUPABASE_URL = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
requireEnv("ENCRYPTION_KEY"); // used by decryptSecret below

const ROUTER = (flag("router") ?? "concentrate") as "concentrate" | "openrouter";
const keyFile = flag("key-file");
const ROUTER_KEY = (
  keyFile
    ? readFileSync(keyFile, "utf8")
    : process.env[`ROUTER_API_KEY_${ROUTER.toUpperCase()}`] ?? process.env.ROUTER_API_KEY ?? ""
).trim();
if (!ROUTER_KEY) {
  console.error(
    `No router key. Set $ROUTER_API_KEY_${ROUTER.toUpperCase()} (or $ROUTER_API_KEY), or pass --key-file <path>.`,
  );
  process.exit(2);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// --- assertions -----------------------------------------------------------

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}
const results: Result[] = [];
/** Every byte this harness printed, for the leak assertion at the end. */
const printed: string[] = [];

function say(line: string): void {
  printed.push(line);
  console.log(line);
}

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  const mark = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  say(`  ${mark}  ${name}${detail && !ok ? `\n          ${detail}` : ""}`);
}

function section(title: string): void {
  say(`\n\x1b[1m${title}\x1b[0m`);
}

/**
 * The engines THIS router is expected to ground — per router, not blanket.
 * OpenRouter carries Claude's native search but cannot ask an OpenAI model for
 * its own, so demanding both would assert something untrue of a
 * correctly-working credential.
 */
function groundable(): Provider[] {
  return routerProviders(ROUTER).filter((p) => routerSupport(ROUTER, p)?.search === "passthrough");
}

async function main() {
  const {
    setRouterKey,
    listRouterKeys,
    removeRouterKey,
    toPublic,
    getDecryptedRouterKeys,
    resolveRunKeyFor,
    executeRun,
  } = await loadLib();

  const email = `lt-router-harness-${Date.now()}@example.com`;
  const { data: created, error: userErr } = await admin.auth.admin.createUser({
    email,
    password: crypto.randomBytes(18).toString("base64url"),
    email_confirm: true,
  });
  if (userErr || !created.user) throw new Error(`Could not create a test user: ${userErr?.message}`);
  const userId = created.user.id;
  say(`test user ${email}  (${userId})`);

  let projectId: string | null = null;

  try {
    // ------------------------------------------------------------------
    section("Schema");
    // ------------------------------------------------------------------
    {
      const { error } = await admin.from("router_keys").select("id").limit(1);
      check("router_keys table exists", !error, error?.message ?? "");

      const { error: routeErr } = await admin.from("runs").select("route").limit(1);
      check("runs.route column exists", !routeErr, routeErr?.message ?? "");

      // The allow-list is what stops a typo'd or retired router id from being
      // stored as if it were real.
      const { error: badRouter } = await admin.from("router_keys").insert({
        user_id: userId,
        router: "litellm",
        encrypted_key: "x",
        key_hint: "x",
      });
      check(
        "an unshipped router id is rejected by the check constraint",
        Boolean(badRouter),
        "litellm was accepted",
      );
    }

    // ------------------------------------------------------------------
    section("Saving a credential (verify → probe → encrypt → store)");
    // ------------------------------------------------------------------
    {
      const outcome = await setRouterKey(admin, userId, {
        router: ROUTER,
        apiKey: ROUTER_KEY,
        label: "harness",
      });
      check("the save path accepted a real key", outcome.ok, outcome.ok ? "" : outcome.message);
      if (!outcome.ok) throw new Error(`cannot continue: ${outcome.message}`);

      const mustGround = groundable();
      check(
        `grounding confirmed for every engine this router can ground (${mustGround.join(", ")})`,
        mustGround.every((p) => outcome.verification.searchVerified.includes(p)),
        `searchVerified=[${outcome.verification.searchVerified}]`,
      );

      const { data: row } = await admin
        .from("router_keys")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();
      const stored = row as Record<string, unknown> | null;

      check("a row landed", Boolean(stored));
      check(
        "the stored key is ciphertext, not the key",
        stored?.encrypted_key !== ROUTER_KEY && String(stored?.encrypted_key ?? "").length > 0,
      );
      check(
        "the ciphertext decrypts back to the exact key",
        decryptSecret(String(stored?.encrypted_key)) === ROUTER_KEY,
      );
      // keyHint keeps 7 leading and 4 trailing characters. What matters is that
      // the middle — the entropy — never survives, so the hint can be shown
      // anywhere without being a partial credential.
      const hint = String(stored?.key_hint ?? "");
      check(
        "the hint masks the body of the key",
        hint.length > 0 &&
          hint !== ROUTER_KEY &&
          hint.includes("…") &&
          !hint.includes(ROUTER_KEY.slice(7, 20)),
        `hint=${hint}`,
      );
      check(
        "search_verified persisted",
        Array.isArray(stored?.search_verified) &&
          (stored!.search_verified as string[]).length === mustGround.length,
        JSON.stringify(stored?.search_verified),
      );

      // What any client is allowed to see.
      const summaries = await listRouterKeys(admin, userId);
      const publicShape = toPublic(summaries[0]);
      check(
        "the public shape carries no ciphertext",
        !Object.keys(publicShape).includes("encrypted_key") &&
          !JSON.stringify(publicShape).includes(ROUTER_KEY),
      );
    }

    // ------------------------------------------------------------------
    section("Reading it back the way a run does");
    // ------------------------------------------------------------------
    {
      const keys = await getDecryptedRouterKeys(admin, userId);
      check("the credential round-trips through the decrypt helper", keys[0]?.apiKey === ROUTER_KEY);
      check(
        "its verified engines came with it",
        groundable().every((p) => keys[0]?.searchVerified.includes(p)),
        `searchVerified=[${keys[0]?.searchVerified}]`,
      );

      // The resolver is what decides a run may use this credential at all.
      const grounded = await resolveRunKeyFor(admin, userId, "anthropic", "claude-haiku-4-5", {
        webSearch: true,
      });
      check(
        "a grounded run resolves to the router",
        grounded.source === "own" && grounded.route?.router === ROUTER,
        `source=${grounded.source} route=${grounded.route?.router}`,
      );
      check(
        "the engine is unchanged by the routing",
        grounded.provider === "anthropic",
        `provider=${grounded.provider}`,
      );

      // An engine the router doesn't serve must not borrow the credential.
      const gemini = await resolveRunKeyFor(admin, userId, "google", undefined, {
        webSearch: true,
      });
      check(
        "an engine the router can't measure is refused",
        gemini.source !== "own",
        `source=${gemini.source}`,
      );
    }

    // ------------------------------------------------------------------
    section("A real monitored run, through the router");
    // ------------------------------------------------------------------
    {
      const { data: proj } = await admin
        .from("projects")
        .insert({
          user_id: userId,
          name: "Router harness",
          brand_name: "Vercel",
          brand_domains: ["vercel.com"],
          default_provider: "anthropic",
          default_model: "claude-haiku-4-5",
          use_web_search: true,
          replicates: 1,
        })
        .select("*")
        .single();
      const project = proj as Project;
      projectId = project.id;

      await admin.from("topics").insert({ project_id: project.id, name: "Hosting" });
      const { data: topic } = await admin
        .from("topics")
        .select("id")
        .eq("project_id", project.id)
        .single();
      await admin.from("prompts").insert({
        project_id: project.id,
        topic_id: (topic as { id: string }).id,
        text: "Which companies offer the best hosting for Next.js apps? Name them.",
        source: "manual",
        is_active: true,
      });

      const key = await resolveRunKeyFor(admin, userId, "anthropic", "claude-haiku-4-5", {
        webSearch: true,
      });
      const result = await executeRun({
        supabase: admin,
        project,
        provider: key.provider,
        model: key.model,
        apiKey: key.apiKey!,
        route: key.route,
      });
      check("the run completed", result.status === "completed", result.error ?? "");
      check("it stored an answer", result.totalResponses > 0, `${result.totalResponses} responses`);
      check("it consumed tokens", result.tokensUsed > 0, `${result.tokensUsed} tokens`);

      const { data: runRow } = await admin
        .from("runs")
        .select("provider, model, route")
        .eq("id", result.runId)
        .single();
      const run = runRow as { provider: string; model: string; route: string | null };
      check(
        "the run is attributed to the ENGINE, not the gateway",
        run.provider === "anthropic",
        `provider=${run.provider}`,
      );
      check(
        "the gateway is recorded alongside it",
        run.route === ROUTER,
        `route=${run.route}`,
      );

      // The whole point of the grounding gate: a routed monitored answer has to
      // come back with real cited sources, not a fluent recall.
      const { data: sources } = await admin
        .from("sources")
        .select("url, domain")
        .eq("run_id", result.runId);
      check(
        "the answer cited live web sources",
        (sources ?? []).length > 0,
        `${(sources ?? []).length} sources`,
      );
      if ((sources ?? []).length > 0) {
        say(`         e.g. ${(sources as { domain: string }[])[0].domain}`);
      }
    }

    // ------------------------------------------------------------------
    section("Revoking it");
    // ------------------------------------------------------------------
    {
      const removed = await removeRouterKey(admin, userId, ROUTER);
      check("remove returns the row it deleted", removed !== null);
      const after = await listRouterKeys(admin, userId);
      check("nothing is left behind", after.length === 0);
      const again = await removeRouterKey(admin, userId, ROUTER);
      check("removing a second time reports nothing stored", again === null);
    }

    // ------------------------------------------------------------------
    section("Secrets");
    // ------------------------------------------------------------------
    check(
      "no output ever contained the key",
      !printed.join("\n").includes(ROUTER_KEY),
      "the key appeared in this harness's own output",
    );
  } finally {
    // Unconditional: a failed assertion must not leave a user, a project, or a
    // credential behind in a real database.
    if (projectId) await admin.from("projects").delete().eq("id", projectId);
    await admin.from("router_keys").delete().eq("user_id", userId);
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    console.log(`\ncleaned up ${email}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} passed` +
      (failed.length ? `, \x1b[31m${failed.length} failed\x1b[0m` : ""),
  );
  if (failed.length) {
    for (const f of failed) console.log(`  \x1b[31m✗\x1b[0m ${f.name}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\nharness aborted: ${(e as Error).message}`);
  process.exit(2);
});
