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
import { c, printJson, table, kv, ok, info, fail } from "./output.mjs";

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
      info(c.yellow(`Not authenticated for "${e.resource}". Launching login...`));
      await login(base, e.resource);
      return await fn();
    }
    throw e;
  }
}

// --- commands -------------------------------------------------------
const commands = {
  async login() {
    if (flags.both) {
      await login(base, "v1", scopeFlag());
      await login(base, "mcp", scopeFlag());
      ok(`Logged in to ${c.cyan(base)} for both REST (v1) and MCP.`);
      return;
    }
    const resource = flags.mcp ? "mcp" : "v1";
    const cred = await login(base, resource, scopeFlag());
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
        rest(base, "POST", `/projects/${projectId}/runs`, {
          body: Object.keys(body).length ? body : undefined,
        }),
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
      const result = await withAutoLoginMcp(() => callTool(base, name, args));
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
      await login(base, "mcp");
      return await fn();
    }
    throw e;
  }
}

function printHelp() {
  const lines = [
    `${c.bold("lettertrace")} - OAuth-authenticated CLI for a Lettertrace deployment`,
    "",
    c.bold("USAGE"),
    "  lettertrace <command> [args] [--json] [--url <base>]",
    "",
    c.bold("AUTH"),
    "  login [--mcp] [--both] [--scope <s>]   Browser OAuth login (default: REST/v1)",
    "  logout                                 Forget and revoke stored tokens",
    "  whoami                                 Show stored credentials",
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
  if (!command || command === "help" || flags.help || flags.h) {
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
  if (e instanceof UsageError) {
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
