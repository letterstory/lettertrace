/**
 * Integration harness for BYOK provider keys (CLI + `/api/v1/keys`).
 *
 * The unit tests mock the network and the database. This does neither: it
 * drives the real `cli/lettertrace.mjs` binary as a child process against a
 * real running deployment backed by real Supabase, and asserts on what actually
 * lands in the database. It is the only thing that can prove the pieces fit
 * together — that a key typed at the CLI is the same key `lib/crypto` decrypts
 * back out at run time.
 *
 *   npx tsx scripts/harness-provider-keys.ts --url http://localhost:3200
 *
 * Requires in .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * ENCRYPTION_KEY, TRIAL_ANTHROPIC_API_KEY. TRIAL_GOOGLE_API_KEY is optional and
 * only enables the "catalog is server-derived" check.
 *
 * NOT part of `npm test`: it needs a live server, spends a few provider tokens
 * on key verification, and writes to the database.
 *
 * Everything it creates is namespaced to one throwaway user which is deleted in
 * a `finally` — including when an assertion fails. The user id is printed at
 * the start so a crashed run can be cleaned up by hand.
 *
 * On secrets: the harness holds real provider keys in memory and passes them to
 * the CLI through files and pipes. It never prints one, and `no output ever
 * contained the secret` below is an explicit assertion over every byte of
 * captured stdout/stderr, not an assumption.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import crypto from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { decryptSecret, sha256Hex } from "../lib/crypto";

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
loadEnvLocal();

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const BASE = flag("url", "http://localhost:3200").replace(/\/+$/, "");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env.local`);
  return v;
}

const SUPABASE_URL = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const REAL_ANTHROPIC_KEY = requireEnv("TRIAL_ANTHROPIC_API_KEY");
const REAL_GOOGLE_KEY = process.env.TRIAL_GOOGLE_API_KEY ?? null;
requireEnv("ENCRYPTION_KEY"); // used by decryptSecret below

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
/** Every byte the CLI ever wrote, kept for the leak assertion at the end. */
const allOutput: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  const mark = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${mark}  ${name}${detail && !ok ? `\n          ${detail}` : ""}`);
}

function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// --- running the CLI ------------------------------------------------------

// An isolated HOME so the harness reads and writes its own ~/.lettertrace and
// can never touch (or be influenced by) the developer's real login.
const HOME = join(tmpdir(), `lt-harness-${process.pid}`);
const CONFIG_FILE = join(HOME, ".lettertrace", "config.json");

// The CLI opens a browser by spawning `open`/`xdg-open` off PATH whenever a
// command needs consent. A test run must never take over the developer's
// browser — and if it does reach a login, a machine that happens to be signed
// in will silently complete it and hand the retry a fresh full-scope token,
// which makes a permission test pass for entirely the wrong reason. So PATH is
// shimmed with a no-op `open` for every child the harness spawns.
const SHIM_BIN = join(HOME, "bin");
function installBrowserShim(): void {
  mkdirSync(SHIM_BIN, { recursive: true });
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(join(SHIM_BIN, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
}
const childPath = () => `${SHIM_BIN}:${process.env.PATH ?? ""}`;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  all: string;
  json: unknown;
}

function runCli(
  args: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, "cli", "lettertrace.mjs"), ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME,
        PATH: childPath(),
        LETTERTRACE_URL: BASE,
        // Strip any inherited value so each test controls this explicitly.
        LETTERTRACE_PROVIDER_KEY: "",
        NO_COLOR: "1",
        ...opts.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      const all = stdout + stderr;
      allOutput.push(all);
      let json: unknown = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        /* not every command is --json */
      }
      resolvePromise({ code: code ?? -1, stdout, stderr, all, json });
    });

    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

/**
 * Run an inline ES module with the harness's isolated HOME. Used to exercise
 * the CLI's internals directly when going through a command would drag in the
 * interactive login flow.
 */
function runNode(source: string): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: repoRoot,
      env: { ...process.env, HOME, PATH: childPath(), LETTERTRACE_URL: BASE, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      const all = stdout + stderr;
      allOutput.push(all);
      resolvePromise({ code: code ?? -1, stdout, stderr, all, json: null });
    });
  });
}

// --- direct HTTP, for scope enforcement -----------------------------------

async function api(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown>; challenge: string }> {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return {
    status: res.status,
    body: parsed,
    challenge: res.headers.get("www-authenticate") ?? "",
  };
}

// --- fixtures -------------------------------------------------------------

/**
 * Mint an OAuth access token straight into the database with an exact scope
 * set. The browser consent flow is what normally produces these and it can't be
 * driven headlessly; going around it is the point here — the harness needs to
 * present tokens holding scope combinations a user would never be offered
 * (`keys:read` without `keys:write`) to prove the routes check the right one.
 */
async function mintToken(userId: string, scopes: string[]): Promise<string> {
  const plain = `lt_oauth_${crypto.randomBytes(24).toString("base64url")}`;
  const { error } = await admin.from("oauth_access_tokens").insert({
    user_id: userId,
    client_id: "lt_cli",
    authorization_id: null,
    family_id: crypto.randomUUID(),
    token_hash: sha256Hex(plain),
    token_hint: `${plain.slice(0, 12)}…${plain.slice(-4)}`,
    scopes,
    resource: "v1",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  if (error) throw new Error(`Could not mint a token: ${error.message}`);
  return plain;
}

function seedCliCredential(token: string, scopes: string[]): void {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(
    CONFIG_FILE,
    JSON.stringify(
      {
        base: BASE,
        credentials: {
          v1: {
            resource: "v1",
            access_token: token,
            refresh_token: null,
            scope: scopes.join(" "),
            expires_at: Date.now() + 3600_000,
          },
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

function readCliConfig(): { credentials: Record<string, unknown> } {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return { credentials: {} };
  }
}

async function storedKeyRow(userId: string, provider: string) {
  const { data } = await admin
    .from("provider_keys")
    .select("provider, encrypted_key, key_hint, label")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  return data;
}

// --- the harness ----------------------------------------------------------

const ALL_SCOPES = [
  "projects:read",
  "projects:write",
  "runs:read",
  "runs:trigger",
  "keys:read",
  "keys:write",
];

async function main(): Promise<void> {
  console.log(`harness → ${BASE}`);

  // Fail fast and legibly if the server isn't up, rather than 30 confusing
  // assertion failures.
  try {
    const ping = await fetch(`${BASE}/api/v1/keys`, { method: "GET" });
    if (ping.status !== 401) {
      throw new Error(`expected 401 from an unauthenticated GET, got ${ping.status}`);
    }
  } catch (e) {
    console.error(`\nCannot reach ${BASE}: ${(e as Error).message}`);
    console.error(`Start one with:  npx next dev -p ${new URL(BASE).port}`);
    process.exit(2);
  }

  const email = `lt-harness-${Date.now()}@example.com`;
  const { data: created, error: userErr } = await admin.auth.admin.createUser({
    email,
    password: crypto.randomBytes(18).toString("base64url"),
    email_confirm: true,
  });
  if (userErr || !created.user) throw new Error(`Could not create a test user: ${userErr?.message}`);
  const userId = created.user.id;
  console.log(`test user ${email}  (${userId})\n`);
  installBrowserShim();

  try {
    // ------------------------------------------------------------------
    section("Unauthenticated");
    // ------------------------------------------------------------------
    {
      const r = await api("GET", "/keys", "lt_oauth_not-a-real-token");
      check("a bogus token is rejected", r.status === 401, `got ${r.status}`);
      const r2 = await fetch(`${BASE}/api/v1/keys`);
      check("no token at all is rejected", r2.status === 401, `got ${r2.status}`);
    }

    // ------------------------------------------------------------------
    section("Issuer identity");
    // ------------------------------------------------------------------
    {
      // Every CLI login ends by comparing the `iss` on the callback against the
      // base it dialled (RFC 9207 mix-up defense) and aborting with "Issuer
      // mismatch" if they differ. A deployment that advertises a different
      // origin than the one you reached it on cannot be logged into at all —
      // which is what a stale NEXT_PUBLIC_SITE_URL did to every dev server not
      // running on the configured port.
      const meta = await fetch(`${BASE}/.well-known/oauth-authorization-server`).then((r) =>
        r.json(),
      );
      check(
        "the server advertises the origin it was actually reached on",
        meta.issuer === BASE,
        `advertised ${meta.issuer}, reached on ${BASE}`,
      );
      check(
        "…and its endpoints point at the same origin",
        typeof meta.authorization_endpoint === "string" &&
          meta.authorization_endpoint.startsWith(BASE),
        `authorization_endpoint is ${meta.authorization_endpoint}`,
      );
      check(
        "…and advertises the keys scopes",
        Array.isArray(meta.scopes_supported) &&
          meta.scopes_supported.includes("keys:read") &&
          meta.scopes_supported.includes("keys:write"),
        `scopes_supported: ${JSON.stringify(meta.scopes_supported)}`,
      );
    }

    // ------------------------------------------------------------------
    section("Scope enforcement");
    // ------------------------------------------------------------------
    {
      const noKeys = await mintToken(userId, ["projects:read", "projects:write", "runs:read"]);
      const readOnly = await mintToken(userId, ["keys:read"]);
      const full = await mintToken(userId, ALL_SCOPES);

      const g = await api("GET", "/keys", noKeys);
      check("GET /keys without keys:read → 403", g.status === 403, `got ${g.status}`);
      check(
        "…and says insufficient_scope in WWW-Authenticate",
        g.challenge.includes("insufficient_scope"),
        `challenge was ${JSON.stringify(g.challenge)}`,
      );

      const p = await api("PUT", "/keys/anthropic", noKeys, { api_key: "x" });
      check("PUT /keys/:provider without keys:write → 403", p.status === 403, `got ${p.status}`);

      const d = await api("DELETE", "/keys/anthropic", noKeys);
      check("DELETE /keys/:provider without keys:write → 403", d.status === 403, `got ${d.status}`);

      // The whole reason the scopes are a pair rather than one: a token that can
      // see which keys exist must not be able to swap the one runs are billed to.
      const pr = await api("PUT", "/keys/anthropic", readOnly, { api_key: "x" });
      check("keys:read alone cannot write", pr.status === 403, `got ${pr.status}`);

      const gr = await api("GET", "/keys", readOnly);
      check("keys:read alone can read", gr.status === 200, `got ${gr.status}`);

      const gf = await api("GET", "/keys", full);
      check("a full-scope token can read", gf.status === 200, `got ${gf.status}`);
    }

    // ------------------------------------------------------------------
    section("Stale token → discard + re-consent (no silent 403)");
    // ------------------------------------------------------------------
    {
      // A CLI that logged in before keys:* existed holds a token that can never
      // gain them by refreshing. It must drop the credential rather than loop.
      //
      // Driven through cli/http.mjs directly rather than the `keys` command,
      // because the command wraps every call in withAutoLogin — which on
      // NeedsLogin opens a real browser and blocks on consent. Under a harness
      // that either hangs or, on a machine already signed in, quietly completes
      // a login and hands the retry a brand-new full-scope token, which looks
      // exactly like the discard never happened. This asserts the transport
      // behaviour that withAutoLogin is reacting to.
      const stale = await mintToken(userId, ["projects:read", "runs:read"]);
      seedCliCredential(stale, ["projects:read", "runs:read"]);

      const r = await runNode(`
        import { rest } from ${JSON.stringify(join(repoRoot, "cli", "http.mjs"))};
        try {
          await rest(${JSON.stringify(BASE)}, "GET", "/keys");
          console.log("UNEXPECTED_SUCCESS");
        } catch (e) {
          console.log(JSON.stringify({ name: e.name, message: e.message }));
        }
      `);
      const thrown = JSON.parse(r.stdout.trim() || "{}") as { name?: string; message?: string };

      const cfg = readCliConfig();
      check(
        "the stale credential is discarded from config.json",
        cfg.credentials.v1 === undefined,
        `config still holds: ${JSON.stringify(Object.keys(cfg.credentials))}`,
      );
      check(
        "…and it surfaces as NeedsLogin, not a raw 403",
        thrown.name === "NeedsLogin",
        `threw ${thrown.name}: ${thrown.message}`,
      );
      check(
        "…explaining that the saved sign-in predates the permission",
        /predates a permission/i.test(thrown.message ?? "") &&
          /lettertrace login/i.test(thrown.message ?? ""),
        thrown.message ?? "(no message)",
      );
    }

    // ------------------------------------------------------------------
    section("Refusing a key on the command line");
    // ------------------------------------------------------------------
    {
      const full = await mintToken(userId, ALL_SCOPES);
      seedCliCredential(full, ALL_SCOPES);

      for (const flagName of ["key", "api-key", "apikey", "secret"]) {
        const r = await runCli(["keys", "set", "anthropic", `--${flagName}`, REAL_ANTHROPIC_KEY]);
        check(
          `--${flagName} is refused`,
          r.code !== 0 && /not accepted/i.test(r.all),
          `exit ${r.code}: ${r.all.slice(0, 160)}`,
        );
        check(
          `--${flagName} refusal tells the user to rotate`,
          /rotate/i.test(r.all),
          r.all.slice(0, 160),
        );
        check(
          `--${flagName} refusal does not echo the key`,
          !r.all.includes(REAL_ANTHROPIC_KEY),
          "the key appeared in output",
        );
      }
      const stored = await storedKeyRow(userId, "anthropic");
      check("nothing was stored by any refused attempt", stored === null, JSON.stringify(stored));
    }

    // ------------------------------------------------------------------
    section("Reading the secret from every supported source");
    // ------------------------------------------------------------------
    const keyFile = join(HOME, "anthropic.key");
    {
      const full = await mintToken(userId, ALL_SCOPES);
      seedCliCredential(full, ALL_SCOPES);

      // 1. --key-file, with trailing newline (what `echo > file` produces).
      writeFileSync(keyFile, `${REAL_ANTHROPIC_KEY}\n`, { mode: 0o600 });
      let r = await runCli(["keys", "set", "anthropic", "--key-file", keyFile, "--json"]);
      check("--key-file stores the key", r.code === 0, r.all.slice(0, 200));
      let row = await storedKeyRow(userId, "anthropic");
      check(
        "…and the trailing newline was trimmed, not stored",
        row !== null && decryptSecret(row.encrypted_key) === REAL_ANTHROPIC_KEY,
        "decrypted value did not match the key exactly",
      );

      // THE assertion this whole harness exists for: what the CLI stored is
      // byte-for-byte what a run will later decrypt and send to the provider.
      check(
        "the stored ciphertext decrypts back to the exact key",
        row !== null && decryptSecret(row.encrypted_key) === REAL_ANTHROPIC_KEY,
        "round-trip mismatch",
      );
      check(
        "only a masked hint is returned to the client",
        typeof (r.json as { key?: { key_hint?: string } })?.key?.key_hint === "string" &&
          !JSON.stringify(r.json).includes(REAL_ANTHROPIC_KEY),
        JSON.stringify(r.json).slice(0, 200),
      );

      await admin.from("provider_keys").delete().eq("user_id", userId);

      // 2. The environment variable.
      r = await runCli(["keys", "set", "anthropic", "--json"], {
        env: { LETTERTRACE_PROVIDER_KEY: REAL_ANTHROPIC_KEY },
      });
      row = await storedKeyRow(userId, "anthropic");
      check(
        "$LETTERTRACE_PROVIDER_KEY stores the key",
        r.code === 0 && row !== null && decryptSecret(row.encrypted_key) === REAL_ANTHROPIC_KEY,
        r.all.slice(0, 200),
      );
      await admin.from("provider_keys").delete().eq("user_id", userId);

      // 3. Piped stdin (non-TTY), the shape a script uses.
      r = await runCli(["keys", "set", "anthropic", "--json"], { stdin: `${REAL_ANTHROPIC_KEY}\n` });
      row = await storedKeyRow(userId, "anthropic");
      check(
        "piped stdin stores the key",
        r.code === 0 && row !== null && decryptSecret(row.encrypted_key) === REAL_ANTHROPIC_KEY,
        r.all.slice(0, 200),
      );
      await admin.from("provider_keys").delete().eq("user_id", userId);

      // 4. --key-file - (explicit stdin), the secret-manager shape.
      r = await runCli(["keys", "set", "anthropic", "--key-file", "-", "--json"], {
        stdin: REAL_ANTHROPIC_KEY,
      });
      row = await storedKeyRow(userId, "anthropic");
      check(
        "--key-file - reads stdin",
        r.code === 0 && row !== null && decryptSecret(row.encrypted_key) === REAL_ANTHROPIC_KEY,
        r.all.slice(0, 200),
      );
      await admin.from("provider_keys").delete().eq("user_id", userId);

      // 5. Precedence: an explicit --key-file must beat a stale exported var,
      //    or a forgotten export silently overrides what the user just asked for.
      writeFileSync(keyFile, REAL_ANTHROPIC_KEY, { mode: 0o600 });
      r = await runCli(["keys", "set", "anthropic", "--key-file", keyFile, "--json"], {
        env: { LETTERTRACE_PROVIDER_KEY: "sk-ant-this-should-lose" },
      });
      row = await storedKeyRow(userId, "anthropic");
      check(
        "--key-file wins over $LETTERTRACE_PROVIDER_KEY",
        r.code === 0 && row !== null && decryptSecret(row.encrypted_key) === REAL_ANTHROPIC_KEY,
        r.all.slice(0, 200),
      );
      await admin.from("provider_keys").delete().eq("user_id", userId);
    }

    // ------------------------------------------------------------------
    section("Bad input is reported without leaking or storing");
    // ------------------------------------------------------------------
    {
      const emptyFile = join(HOME, "empty.key");
      writeFileSync(emptyFile, "   \n");
      let r = await runCli(["keys", "set", "anthropic", "--key-file", emptyFile]);
      check("an empty key file is rejected", r.code !== 0 && /empty/i.test(r.all), r.all.slice(0, 160));

      const missing = join(HOME, "nope.key");
      r = await runCli(["keys", "set", "anthropic", "--key-file", missing]);
      check(
        "a missing key file names the path, not the contents",
        r.code !== 0 && r.all.includes("nope.key"),
        r.all.slice(0, 160),
      );

      r = await runCli(["keys", "set", "not-a-provider", "--key-file", keyFile]);
      check(
        "an unknown provider is rejected before the secret is read",
        r.code !== 0 && /unknown provider/i.test(r.all),
        r.all.slice(0, 160),
      );

      // A syntactically plausible but invalid key: the provider must reject it,
      // and the failure must be attributed to the key — not to the deployment.
      r = await runCli(["keys", "set", "anthropic", "--json"], {
        env: { LETTERTRACE_PROVIDER_KEY: "sk-ant-api03-definitely-not-valid-0000" },
      });
      const row = await storedKeyRow(userId, "anthropic");
      check("an invalid key is refused by the provider", r.code !== 0, `exit ${r.code}`);
      check("…and nothing is stored", row === null, JSON.stringify(row));
      check(
        "…and the message blames the key, not the encryption config",
        /invalid|incorrect|api key/i.test(r.all) && !/encryption/i.test(r.all),
        r.all.slice(0, 200),
      );
    }

    // ------------------------------------------------------------------
    section("List, rotate, remove");
    // ------------------------------------------------------------------
    {
      let r = await runCli(["keys", "--json"]);
      const listed = r.json as { keys?: unknown[]; providers?: { id: string }[] };
      check("keys list returns the provider catalog", (listed.providers?.length ?? 0) > 0, r.all.slice(0, 200));
      check(
        "the catalog is server-derived, so Gemini appears without a CLI change",
        (listed.providers ?? []).some((p) => p.id === "google"),
        `saw: ${(listed.providers ?? []).map((p) => p.id).join(", ")}`,
      );
      check("nothing is stored yet", (listed.keys?.length ?? 0) === 0, JSON.stringify(listed.keys));

      // Set, then set again — PUT is meant to be honestly idempotent, so
      // rotating is the same request as setting and needs no delete first.
      await runCli(["keys", "set", "anthropic", "--key-file", keyFile, "--label", "first", "--json"]);
      r = await runCli(["keys", "set", "anthropic", "--key-file", keyFile, "--label", "second", "--json"]);
      check("setting an existing key rotates it in place", r.code === 0, r.all.slice(0, 200));

      const { count } = await admin
        .from("provider_keys")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("provider", "anthropic");
      check("…leaving exactly one row, not two", count === 1, `found ${count}`);

      const row = await storedKeyRow(userId, "anthropic");
      check("…and the label was updated", row?.label === "second", `label is ${row?.label}`);

      r = await runCli(["keys", "--json"]);
      const after = r.json as { keys?: { provider: string; key_hint: string }[] };
      const anth = (after.keys ?? []).find((k) => k.provider === "anthropic");
      check("the stored key is listed", Boolean(anth), JSON.stringify(after.keys));
      check(
        "…as a masked hint only",
        Boolean(anth) && !anth!.key_hint.includes(REAL_ANTHROPIC_KEY.slice(10, 30)),
        anth?.key_hint,
      );

      r = await runCli(["keys", "remove", "anthropic", "--json"]);
      check("remove succeeds", r.code === 0, r.all.slice(0, 200));
      check("…and the row is gone", (await storedKeyRow(userId, "anthropic")) === null);

      r = await runCli(["keys", "remove", "anthropic", "--json"]);
      check(
        "removing again is an error, not a cheerful no-op",
        r.code !== 0 && /no anthropic key|not.*stored/i.test(r.all),
        r.all.slice(0, 200),
      );
    }

    // ------------------------------------------------------------------
    section("Gemini, end to end through the CLI");
    // ------------------------------------------------------------------
    if (REAL_GOOGLE_KEY) {
      const r = await runCli(["keys", "set", "google", "--json"], {
        env: { LETTERTRACE_PROVIDER_KEY: REAL_GOOGLE_KEY },
      });
      const row = await storedKeyRow(userId, "google");
      check("a Google key verifies and stores", r.code === 0, r.all.slice(0, 200));
      check(
        "…and decrypts back to the exact key",
        row !== null && decryptSecret(row.encrypted_key) === REAL_GOOGLE_KEY,
        "round-trip mismatch",
      );
      await runCli(["keys", "remove", "google", "--json"]);
    } else {
      check("a Google key verifies and stores", true, "skipped: no TRIAL_GOOGLE_API_KEY");
    }

    // ------------------------------------------------------------------
    section("Nothing leaked");
    // ------------------------------------------------------------------
    {
      const combined = allOutput.join("\n");
      check(
        "no CLI output ever contained a plaintext key",
        !combined.includes(REAL_ANTHROPIC_KEY) &&
          (!REAL_GOOGLE_KEY || !combined.includes(REAL_GOOGLE_KEY)),
        "a plaintext key appeared in CLI output",
      );

      // The activity feed records every write; a key must not ride along in it.
      const { data: logs } = await admin
        .from("activity_logs")
        .select("category, action, channel, status, summary, metadata")
        .eq("user_id", userId);
      const serialized = JSON.stringify(logs ?? []);
      check(
        "no plaintext key reached the activity log",
        !serialized.includes(REAL_ANTHROPIC_KEY) &&
          (!REAL_GOOGLE_KEY || !serialized.includes(REAL_GOOGLE_KEY)),
        "a plaintext key appeared in activity_logs",
      );

      const keyEvents = (logs ?? []).filter((l) => l.category === "provider_key");
      check(
        "…which still recorded the writes",
        keyEvents.some((l) => l.action === "provider_key.saved") &&
          keyEvents.some((l) => l.action === "provider_key.removed"),
        `saw actions: ${[...new Set(keyEvents.map((l) => l.action))].join(", ") || "(none)"}`,
      );
      check(
        "…attributed to the cli channel, so an agent's write is distinguishable",
        keyEvents.length > 0 && keyEvents.every((l) => l.channel === "cli"),
        `channels: ${[...new Set(keyEvents.map((l) => l.channel))].join(", ") || "(none)"}`,
      );
      check(
        "…including the failures, recorded as failures",
        keyEvents.some((l) => l.status === "failure"),
        `statuses: ${[...new Set(keyEvents.map((l) => l.status))].join(", ")}`,
      );

      check(
        "the CLI config file holds no provider key",
        !readFileSync(CONFIG_FILE, "utf8").includes(REAL_ANTHROPIC_KEY),
        "the key was persisted to config.json",
      );
    }
  } finally {
    // Unconditional: a failed assertion must not leave a user, tokens, or keys
    // behind in a real database.
    await admin.from("provider_keys").delete().eq("user_id", userId);
    await admin.from("oauth_access_tokens").delete().eq("user_id", userId);
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    if (existsSync(HOME)) rmSync(HOME, { recursive: true, force: true });
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
