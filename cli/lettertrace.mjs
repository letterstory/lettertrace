#!/usr/bin/env node
/**
 * lettertrace: a full command-line client for a Lettertrace deployment.
 *
 * Authentication is OAuth 2.1 only (no API keys): the first command that needs
 * access opens your browser to approve a scoped, expiring token, stored under
 * ~/.lettertrace/config.json and refreshed automatically. The data commands use
 * the REST v1 API; the `mcp` commands speak the Model Context Protocol directly
 * to /api/mcp, exactly as an AI assistant would.
 *
 * Run `lettertrace help` for the command list. Base URL comes from --url, then
 * $LETTERTRACE_URL, then the URL saved at login, then http://localhost:3000.
 */

import { resolveBase, loadConfig } from "./config.mjs";
import { login, logout, getAccessToken, revoke, NeedsLogin } from "./oauth.mjs";
import { rest, ApiError } from "./http.mjs";
import { listTools, callTool, renderToolResult } from "./mcp.mjs";
import { readSecret, SecretInputError, SECRET_ENV } from "./secret.mjs";
import { c, printJson, table, kv, ok, info, fail } from "./output.mjs";
import { banner, withSpinner } from "./brand.mjs";

// --- arg parsing ----------------------------------------------------
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

const { positionals, flags } = parseArgs(process.argv.slice(2));
const [command, ...rest_] = positionals;
const JSON_OUT = Boolean(flags.json);
// Use the IPv6 loopback ([::1]) for the OAuth redirect instead of 127.0.0.1.
const IPV6 = Boolean(flags.ipv6);
const base = resolveBase(typeof flags.url === "string" ? flags.url : undefined);

// --- helpers --------------------------------------------------------
const pct = (n) => (n === null || n === undefined ? "n/a" : `${Math.round(n * 100)}%`);
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s ?? "");
const rel = (ms) => {
  if (!ms) return "unknown";
  const d = ms - Date.now();
  const s = Math.round(Math.abs(d) / 1000);
  const unit = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
  return d >= 0 ? `in ${unit}` : `${unit} ago`;
};
const coerce = (v) => {
  if (v === true) return true;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};
function need(value, message) {
  if (value === undefined || value === null || value === "" || value === true) {
    throw new UsageError(message);
  }
  return value;
}
class UsageError extends Error {}

// Build a table from whatever primitive columns the rows share (for dynamic
// shapes like report entities).
function dynamicTable(rows) {
  if (!rows || rows.length === 0) return info(c.dim("(none)"));
  const keys = Object.keys(rows[0]).filter((k) => {
    const v = rows[0][k];
    return v === null || ["string", "number", "boolean"].includes(typeof v);
  });
  table(rows, keys.map((k) => ({ key: k })));
}

// Run a data command, auto-launching the OAuth login for the exact audience it
// needs if there is no usable credential yet, then retrying once.
async function withAutoLogin(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof NeedsLogin) {
      info(c.yellow(`${e.detail ?? `Not authenticated for "${e.resource}".`} Launching login...`));
      await login(base, e.resource, { ipv6: IPV6 });
      return await fn();
    }
    throw e;
  }
}

// --- commands -------------------------------------------------------
const commands = {
  async login() {
    const opts = { scope: scopeFlag(), ipv6: IPV6 };
    if (flags.both) {
      await login(base, "v1", opts);
      await login(base, "mcp", opts);
      ok(`Logged in to ${c.cyan(base)} for both REST (v1) and MCP.`);
      return;
    }
    const resource = flags.mcp ? "mcp" : "v1";
    const cred = await login(base, resource, opts);
    ok(`Logged in to ${c.cyan(base)} for ${resource.toUpperCase()} (expires ${rel(cred.expires_at)}).`);
    if (resource === "v1") info(c.dim("Tip: `lettertrace login --mcp` to also use the MCP commands."));
  },

  async logout() {
    const { tokens } = logout();
    await Promise.all(tokens.map((t) => revoke(base, t)));
    ok("Logged out and revoked stored tokens.");
  },

  whoami() {
    const cfg = loadConfig();
    const resources = Object.values(cfg.credentials || {});
    if (JSON_OUT) {
      // Machine-readable auth status, safe to parse (no token values). Lets an
      // agent decide whether it still needs the human sign-in step.
      return printJson({
        deployment: cfg.base ?? base,
        authenticated: {
          v1: Boolean(cfg.credentials?.v1),
          mcp: Boolean(cfg.credentials?.mcp),
        },
        credentials: resources.map((r) => ({
          resource: r.resource,
          scope: r.scope,
          access_expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
          has_refresh: Boolean(r.refresh_token),
        })),
      });
    }
    if (resources.length === 0) return info("Not logged in. Run: lettertrace login");
    info(`${c.dim("deployment")}  ${cfg.base ?? base}`);
    table(resources, [
      { key: "resource", label: "SURFACE", map: (v) => v.toUpperCase() },
      { key: "scope", label: "SCOPES" },
      { key: "expires_at", label: "ACCESS EXPIRES", map: (v) => rel(v) },
      { key: "refresh_token", label: "REFRESH", map: (v) => (v ? "yes" : "no") },
    ]);
  },

  // BYOK provider keys. The secret itself never travels through argv (see
  // cli/secret.mjs); this command only ever handles the masked hint the server
  // returns. The provider list comes from the server too, so a provider added
  // to the deployment's catalog works here with no new CLI release.
  async keys() {
    const sub = rest_[0] ?? "list";

    // A key passed as a flag is already burned — it is in the shell history and
    // was visible in `ps` the moment the process started. Refuse loudly rather
    // than ignoring the flag and letting the user believe it went nowhere.
    for (const banned of ["key", "api-key", "apikey", "secret"]) {
      if (flags[banned] !== undefined) {
        throw new UsageError(
          `--${banned} is not accepted: a key on the command line leaks into shell history and process lists. ` +
            `Pipe it in, set $${SECRET_ENV}, or use --key-file <path>. Rotate that key.`,
        );
      }
    }

    if (sub === "set") {
      const provider = need(rest_[1], "keys set needs a <provider> (see `lettertrace keys`)");
      // Authenticate and fetch the catalog BEFORE asking for the secret. That
      // gets any browser consent out of the way while the terminal is still
      // free, and it rejects a mistyped provider before the user has pasted a
      // key we would only throw away.
      const current = await withAutoLogin(() => rest(base, "GET", "/keys"));
      const supported = current.providers ?? [];
      const match = supported.find((p) => p.id === provider);
      if (!match) {
        throw new UsageError(
          `Unknown provider "${provider}". This deployment supports: ${supported.map((p) => p.id).join(", ") || "(none)"}.`,
        );
      }

      const apiKey = await readSecret({
        file: typeof flags["key-file"] === "string" ? flags["key-file"] : undefined,
        label: `${match.label} key (input hidden): `,
      });
      const body = { api_key: apiKey };
      if (typeof flags.label === "string") body.label = flags.label;

      const out = await withAutoLogin(() =>
        withSpinner(
          `Verifying your ${match.label} key...`,
          () => rest(base, "PUT", `/keys/${provider}`, { body }),
          { enabled: !JSON_OUT },
        ),
      );
      if (JSON_OUT) return printJson(out);
      ok(`Verified and stored your ${match.label} key (${out.key.key_hint}).`);
      return;
    }

    if (sub === "remove" || sub === "rm") {
      const provider = need(rest_[1], "keys remove needs a <provider>");
      const out = await withAutoLogin(() => rest(base, "DELETE", `/keys/${provider}`));
      if (JSON_OUT) return printJson(out);
      ok(`Removed the ${provider} key (${out.key.key_hint}).`);
      return;
    }

    // list: one row per supported provider, set or not, so this doubles as the
    // answer to "what can I configure here?".
    const out = await withAutoLogin(() => rest(base, "GET", "/keys"));
    if (JSON_OUT) return printJson(out);
    const stored = new Map((out.keys ?? []).map((k) => [k.provider, k]));
    table(
      (out.providers ?? []).map((p) => ({
        provider: p.id,
        name: p.label,
        key: stored.get(p.id)?.key_hint ?? c.dim("not set"),
        added: stored.get(p.id)?.created_at ?? "",
        where: p.key_url,
      })),
      [
        { key: "provider", label: "PROVIDER" },
        { key: "name", label: "NAME" },
        { key: "key", label: "STORED KEY" },
        { key: "added", label: "ADDED" },
        { key: "where", label: "GET A KEY" },
      ],
    );
    info(c.dim("\nSet one with: lettertrace keys set <provider>  (the key is never typed as an argument)"));
  },

  async projects() {
    const sub = rest_[0] ?? "list";
    if (sub === "create") {
      const body = {
        name: need(flags.name, "projects create needs --name"),
        brand_name: need(flags.brand ?? flags["brand-name"], "projects create needs --brand"),
      };
      if (flags.domains) body.brand_domains = String(flags.domains).split(",").map((s) => s.trim()).filter(Boolean);
      if (flags.description) body.description = flags.description;
      if (flags.provider) body.default_provider = flags.provider;
      if (flags.model) body.default_model = flags.model;
      const out = await withAutoLogin(() => rest(base, "POST", "/projects", { body }));
      if (JSON_OUT) return printJson(out);
      ok(`Created organization ${c.bold(out.project.name)} (${out.project.id}).`);
      return;
    }
    // list
    const out = await withAutoLogin(() => rest(base, "GET", "/projects"));
    if (JSON_OUT) return printJson(out.projects);
    table(out.projects, [
      { key: "id", label: "ID" },
      { key: "name", label: "NAME" },
      { key: "brand_name", label: "BRAND" },
      { key: "last_run_at", label: "LAST RUN", map: (v) => v ?? "never" },
    ]);
  },

  async prompts() {
    const sub = rest_[0];
    if (sub === "add") {
      const projectId = need(rest_[1], "prompts add needs a <projectId>");
      const body = {
        prompts: [
          {
            text: need(flags.text, "prompts add needs --text"),
            topic: need(flags.topic, "prompts add needs --topic"),
          },
        ],
      };
      const out = await withAutoLogin(() =>
        rest(base, "POST", `/projects/${projectId}/prompts`, { body }),
      );
      if (JSON_OUT) return printJson(out);
      ok(`Added ${out.created.length} prompt(s), skipped ${out.skipped}.`);
      return;
    }
    if (sub === "toggle") {
      const promptId = need(rest_[1], "prompts toggle needs a <promptId>");
      if (!flags.on && !flags.off) throw new UsageError("prompts toggle needs --on or --off");
      const out = await withAutoLogin(() =>
        rest(base, "PATCH", `/prompts/${promptId}`, { body: { is_active: Boolean(flags.on) } }),
      );
      if (JSON_OUT) return printJson(out);
      ok(`Prompt ${promptId} is now ${out.prompt.is_active ? "active" : "inactive"}.`);
      return;
    }
    // list: prompts <projectId>
    const projectId = need(sub, "prompts needs a <projectId>");
    const out = await withAutoLogin(() => rest(base, "GET", `/projects/${projectId}/prompts`));
    if (JSON_OUT) return printJson(out.prompts);
    table(out.prompts, [
      { key: "id", label: "ID" },
      { key: "topic", label: "TOPIC" },
      { key: "is_active", label: "ACTIVE", map: (v) => (v ? "yes" : "no") },
      { key: "text", label: "TEXT", map: (v) => trunc(v, 60) },
    ]);
  },

  async runs() {
    const sub = rest_[0];
    if (sub === "trigger") {
      const projectId = need(rest_[1], "runs trigger needs a <projectId>");
      const body = {};
      if (flags.provider) body.provider = flags.provider;
      if (flags.model) body.model = flags.model;
      const out = await withAutoLogin(() =>
        withSpinner(
          "Running your prompts across the model...",
          () =>
            rest(base, "POST", `/projects/${projectId}/runs`, {
              body: Object.keys(body).length ? body : undefined,
            }),
          { enabled: !JSON_OUT },
        ),
      );
      if (JSON_OUT) return printJson(out);
      ok(`Run ${c.bold(out.runId)} ${out.status} (${out.totalResponses} responses).`);
      return;
    }
    if (sub === "get") {
      const runId = need(rest_[1], "runs get needs a <runId>");
      const report = await withAutoLogin(() => rest(base, "GET", `/runs/${runId}`));
      if (JSON_OUT) return printJson(report);
      const s = report.summary;
      kv({
        Run: report.run.id,
        Model: `${report.run.provider}/${report.run.model}`,
        Responses: report.totalResponses,
        "Brand mention rate": pct(s.brandMentionRate),
        "Share of voice": pct(s.brandShareOfVoice),
        "Owned-citation rate": pct(report.citations?.ownedCitationRate),
      });
      if (report.entities?.length) {
        info("");
        dynamicTable(report.entities);
      }
      info(c.dim("\nUse --json for the full report."));
      return;
    }
    if (sub === "responses") {
      const runId = need(rest_[1], "runs responses needs a <runId>");
      const out = await withAutoLogin(() => rest(base, "GET", `/runs/${runId}/responses`));
      if (JSON_OUT) return printJson(out);
      info(`${out.responses.length} response(s) for run ${runId}:`);
      table(out.responses, [
        { key: "provider", label: "PROVIDER" },
        { key: "model", label: "MODEL" },
        { key: "prompt_text", label: "PROMPT", map: (v) => trunc(v, 50) },
        { key: "response_text", label: "ANSWER", map: (v) => trunc(v, 60) },
      ]);
      info(c.dim("Use --json for full text, sources, and mentions."));
      return;
    }
    // list: runs <projectId>
    const projectId = need(sub, "runs needs a <projectId>");
    const query = flags.limit ? { limit: Number(flags.limit) } : undefined;
    const out = await withAutoLogin(() => rest(base, "GET", `/projects/${projectId}/runs`, { query }));
    if (JSON_OUT) return printJson(out.runs);
    table(out.runs, [
      { key: "id", label: "ID" },
      { key: "status", label: "STATUS" },
      { key: "model", label: "MODEL" },
      { key: "prompt_count", label: "PROMPTS" },
      { key: "created_at", label: "CREATED" },
    ]);
  },

  async history() {
    const projectId = need(rest_[0], "history needs a <projectId>");
    const query = flags.limit ? { limit: Number(flags.limit) } : undefined;
    const out = await withAutoLogin(() =>
      rest(base, "GET", `/projects/${projectId}/history`, { query }),
    );
    if (JSON_OUT) return printJson(out);
    kv({
      Brand: out.brandName,
      "Ever mentioned": out.everMentioned ? "yes" : "no",
      "First mention": out.firstMentionAt ?? "not yet",
      Runs: out.points.length,
    });
    if (out.points.length) {
      info("");
      table(out.points, [
        { key: "createdAt", label: "WHEN" },
        { key: "model", label: "MODEL" },
        { key: "brandMentionRate", label: "MENTION", map: (v) => pct(v) },
        { key: "ownedCitationRate", label: "OWNED CITES", map: (v) => pct(v) },
      ]);
    }
  },

  async logs() {
    const query = {};
    if (flags.limit) query.page_size = Number(flags.limit);
    if (flags.channel) query.channel = flags.channel;
    if (flags.category) query.category = flags.category;
    if (flags.status) query.status = flags.status;
    if (flags.days) query.days = Number(flags.days);
    const search = flags.q ?? flags.search;
    if (search && typeof search === "string") query.q = search;
    const out = await withAutoLogin(() =>
      rest(base, "GET", "/logs", {
        query: Object.keys(query).length ? query : undefined,
      }),
    );
    if (JSON_OUT) return printJson(out);
    info(`${out.total} total event(s); showing ${out.logs.length}:`);
    table(out.logs, [
      { key: "created_at", label: "WHEN" },
      { key: "channel", label: "CHANNEL" },
      { key: "actor_label", label: "ACTOR", map: (v) => trunc(v, 22) },
      { key: "action", label: "ACTION" },
      { key: "status", label: "STATUS" },
      { key: "summary", label: "SUMMARY", map: (v) => trunc(v, 50) },
    ]);
  },

  async mcp() {
    const sub = rest_[0];
    if (sub === "tools") {
      const tools = await withAutoLoginMcp(() => listTools(base));
      if (JSON_OUT) return printJson(tools);
      table(tools, [
        { key: "name", label: "TOOL" },
        { key: "description", label: "DESCRIPTION", map: (v) => trunc(v, 80) },
      ]);
      return;
    }
    if (sub === "call") {
      const name = need(rest_[1], "mcp call needs a <tool> name (see `mcp tools`)");
      const args = {};
      for (const [k, v] of Object.entries(flags)) {
        if (k === "json" || k === "url") continue;
        args[k] = coerce(v);
      }
      const result = await withAutoLoginMcp(() =>
        withSpinner(
          `Calling ${name}...`,
          () => callTool(base, name, args),
          { enabled: !JSON_OUT },
        ),
      );
      if (JSON_OUT) return printJson(result);
      const { text, isError } = renderToolResult(result);
      if (isError) fail(text || "Tool returned an error.");
      else process.stdout.write((text || "(no output)") + "\n");
      return;
    }
    throw new UsageError("mcp needs a subcommand: `mcp tools` or `mcp call <tool>`");
  },

  help() {
    printHelp();
  },
};

function scopeFlag() {
  return typeof flags.scope === "string" ? flags.scope : undefined;
}

// The mcp audience needs its own credential; auto-login uses NeedsLogin.resource.
async function withAutoLoginMcp(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof NeedsLogin) {
      info(c.yellow(`Not authenticated for "mcp". Launching login...`));
      await login(base, "mcp", { ipv6: IPV6 });
      return await fn();
    }
    throw e;
  }
}

function printHelp() {
  // The splash is decorative: keep it off stdout under --json so nothing but
  // the (already non-JSON) help text is added for a script that asks for it.
  if (!JSON_OUT) process.stdout.write(banner());
  const lines = [
    c.bold("USAGE"),
    "  lettertrace <command> [args] [--json] [--url <base>]",
    "",
    c.bold("AUTH"),
    "  login [--mcp] [--both] [--ipv6] [--scope <s>]  Browser OAuth login (default REST/v1)",
    "         --ipv6 uses the http://[::1]:<port>/callback redirect instead of 127.0.0.1",
    "  logout                                 Forget and revoke stored tokens",
    "  whoami                                 Show stored credentials",
    "",
    c.bold("PROVIDER KEYS (BYOK)"),
    "  keys                                   Which AI provider keys are stored (masked)",
    "  keys set <provider> [--key-file <p>] [--label <l>]",
    "                                         Verify + store a key. The key is read from",
    `                                         --key-file (- = stdin), $${SECRET_ENV},`,
    "                                         piped stdin, or a hidden prompt — never a flag.",
    "  keys remove <provider>                 Forget the stored key for a provider",
    "",
    c.bold("DATA (REST v1)"),
    "  projects                               List organizations",
    "  projects create --name <n> --brand <b> [--domains a,b] [--description <d>]",
    "  prompts <projectId>                    List a project's prompts",
    "  prompts add <projectId> --text <t> --topic <top>",
    "  prompts toggle <promptId> --on|--off",
    "  runs <projectId> [--limit <n>]         List runs",
    "  runs trigger <projectId> [--provider <p>] [--model <m>]",
    "  runs get <runId>                       Share-of-voice report",
    "  runs responses <runId>                 Raw answers, sources, mentions",
    "  history <projectId> [--limit <n>]      Brand visibility over time",
    "  logs [--channel c] [--category c] [--status s] [--days n] [--q text] [--limit n]",
    "                                         Account activity feed (users, agents, cron)",
    "",
    c.bold("MCP (Model Context Protocol)"),
    "  mcp tools                              List the MCP tools",
    "  mcp call <tool> [--arg value ...]      Call an MCP tool",
    "",
    c.dim("Tokens live in ~/.lettertrace/config.json. Base URL: --url, then"),
    c.dim("$LETTERTRACE_URL, then the login URL, then http://localhost:3000."),
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

// --- dispatch -------------------------------------------------------
async function main() {
  if (!command || command === "help" || command === "-h" || flags.help || flags.h) {
    printHelp();
    return;
  }
  const handler = commands[command];
  if (!handler) {
    fail(`Unknown command: ${command}`);
    info("Run `lettertrace help` for the command list.");
    process.exitCode = 1;
    return;
  }
  await handler();
}

main().catch((e) => {
  if (e instanceof UsageError || e instanceof SecretInputError) {
    fail(e.message);
  } else if (e instanceof ApiError) {
    fail(`API error ${e.status}: ${e.message}`);
  } else if (e instanceof NeedsLogin) {
    fail(e.message);
  } else {
    fail(e instanceof Error ? e.message : String(e));
  }
  process.exitCode = 1;
});
