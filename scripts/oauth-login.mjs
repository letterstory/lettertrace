#!/usr/bin/env node
/**
 * Reference Lettertrace CLI login — the "homebuilt CLI utility" this OAuth
 * mechanism exists for. It obtains a scoped, expiring access token via the
 * OAuth 2.1 Authorization Code + PKCE flow over a loopback redirect (RFC 8252),
 * with NO api key ever pasted by hand.
 *
 *   node scripts/oauth-login.mjs                       # log in (REST API scope)
 *   node scripts/oauth-login.mjs --resource mcp        # bind the token to MCP
 *   node scripts/oauth-login.mjs --scope "projects:read runs:read offline_access"
 *   node scripts/oauth-login.mjs --refresh             # rotate using saved refresh token
 *
 * Base URL: --url <origin>, else $LETTERTRACE_URL, else http://localhost:3000.
 * Tokens are written to ~/.lettertrace/credentials.json (chmod 600).
 *
 * Depends only on Node built-ins (Node >= 18 for global fetch).
 */

import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const CLIENT_ID = "lt_cli";

// --- args -----------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const BASE = (flag("url", process.env.LETTERTRACE_URL || "http://localhost:3000")).replace(/\/+$/, "");
const RESOURCE = flag("resource", "v1"); // "v1" | "mcp"
const SCOPE = flag("scope", "projects:read projects:write runs:read runs:trigger offline_access");

const CRED_DIR = path.join(os.homedir(), ".lettertrace");
const CRED_FILE = path.join(CRED_DIR, "credentials.json");

// --- helpers --------------------------------------------------------
const b64url = (buf) => buf.toString("base64url");

function saveCredentials(tokens) {
  fs.mkdirSync(CRED_DIR, { recursive: true });
  const payload = {
    base: BASE,
    resource: RESOURCE,
    obtained_at: new Date().toISOString(),
    ...tokens,
  };
  fs.writeFileSync(CRED_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CRED_FILE, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
  console.log(`\nSaved credentials to ${CRED_FILE}`);
}

function loadCredentials() {
  try {
    return JSON.parse(fs.readFileSync(CRED_FILE, "utf8"));
  } catch {
    return null;
  }
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* fall back to the printed URL */
  }
}

async function tokenRequest(body) {
  const res = await fetch(`${BASE}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`token endpoint ${res.status}: ${json.error || "unknown_error"}`);
  }
  return json;
}

// --- refresh mode ---------------------------------------------------
async function refreshFlow() {
  const creds = loadCredentials();
  if (!creds?.refresh_token) {
    console.error("No saved refresh token. Run without --refresh to log in first.");
    process.exit(1);
  }
  console.log("Rotating access token via refresh_token grant…");
  const tokens = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: creds.refresh_token,
    client_id: CLIENT_ID,
  });
  saveCredentials(tokens);
  console.log(`New access token (expires in ${tokens.expires_in}s): ${tokens.access_token.slice(0, 18)}…`);
}

// --- login (authorization_code + PKCE + loopback) -------------------
async function loginFlow() {
  // 1. PKCE + CSRF material.
  const codeVerifier = b64url(crypto.randomBytes(48)); // 64 chars, within 43–128
  const codeChallenge = b64url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = b64url(crypto.randomBytes(16));

  // 2. Loopback listener on an ephemeral port.
  let redirectUri = "";
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const params = url.searchParams;
      const finish = (title, body) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset=utf-8><title>${title}</title>` +
            `<body style="font-family:system-ui;max-width:30rem;margin:5rem auto;text-align:center">` +
            `<h1>${title}</h1><p>${body}</p></body>`,
        );
        server.close();
      };

      if (params.get("error")) {
        finish("Authorization failed", `Error: ${params.get("error")}. You can close this tab.`);
        reject(new Error(`authorize error: ${params.get("error")}`));
        return;
      }
      if (params.get("state") !== state) {
        finish("Authorization failed", "State mismatch — possible tampering. Close this tab.");
        reject(new Error("state mismatch"));
        return;
      }
      if (params.get("iss") && params.get("iss").replace(/\/+$/, "") !== BASE) {
        finish("Authorization failed", "Issuer mismatch. Close this tab.");
        reject(new Error("issuer mismatch"));
        return;
      }
      finish("You're signed in", "Return to your terminal — you can close this tab.");
      resolve(params.get("code"));
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      redirectUri = `http://127.0.0.1:${port}/callback`;

      const authorize = new URL(`${BASE}/api/oauth/authorize`);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("client_id", CLIENT_ID);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("scope", SCOPE);
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("code_challenge", codeChallenge);
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("resource", RESOURCE);

      console.log("\nOpening your browser to approve access…");
      console.log(`If it doesn't open, visit:\n  ${authorize.toString()}\n`);
      openBrowser(authorize.toString());
    });

    // Give up rather than hang forever.
    setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for authorization (5 min)"));
    }, 5 * 60 * 1000).unref();
  });

  // 3. Exchange the code for tokens (PKCE proves this is the same process).
  console.log("Exchanging authorization code for tokens…");
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  });

  saveCredentials(tokens);
  // Truncated, matching the refresh path: the full token lives only in the
  // credentials file. Printing it whole puts a live bearer token in terminal
  // scrollback and any log that captures this run.
  console.log(`\nAccess token (expires in ${tokens.expires_in}s, scope "${tokens.scope}"):`);
  console.log(`  ${tokens.access_token.slice(0, 18)}…`);
  if (tokens.refresh_token) console.log("Refresh token stored for silent re-auth.");

  // 4. Prove it works against the surface it was bound to.
  if (RESOURCE === "v1") {
    const res = await fetch(`${BASE}/api/v1/projects`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const body = await res.json().catch(() => ({}));
    console.log(
      `\nGET /api/v1/projects -> ${res.status}` +
        (Array.isArray(body.projects) ? ` (${body.projects.length} organization(s))` : ""),
    );
  } else {
    // The command is shown with a shell substitution rather than the literal
    // token, so pasting it never lands the credential in shell history.
    console.log("\nToken is bound to MCP. Add it to an MCP client with:");
    console.log(`  claude mcp add --transport http lettertrace ${BASE}/api/mcp/mcp \\`);
    console.log(
      `    -H "Authorization: Bearer $(node -p 'JSON.parse(require("fs").readFileSync("${CRED_FILE}","utf8")).access_token')"`,
    );
  }
}

// --- main -----------------------------------------------------------
(async () => {
  try {
    if (has("refresh")) await refreshFlow();
    else await loginFlow();
  } catch (e) {
    console.error(`\nLogin failed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
})();
