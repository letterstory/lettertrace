import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Persistent CLI state: the deployment base URL and one credential per resource
// audience ("v1" for the REST API, "mcp" for the MCP endpoint). Because OAuth
// access tokens are audience-bound, the CLI keeps them separate and uses the
// right one for each command. Stored 0600 in the user's home directory.

export const CONFIG_DIR = path.join(os.homedir(), ".lettertrace");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    cfg.credentials = cfg.credentials || {};
    return cfg;
  } catch {
    return { credentials: {} };
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    /* platforms without POSIX modes */
  }
}

// Base URL precedence: explicit --url, then $LETTERTRACE_URL, then the base
// saved at login, then the hosted default at https://lettertrace.com.
export function resolveBase(cliUrl) {
  const stored = loadConfig().base;
  const base = cliUrl || process.env.LETTERTRACE_URL || stored || "https://lettertrace.com";
  return base.replace(/\/+$/, "");
}
