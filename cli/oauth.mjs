import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { loadConfig, saveConfig } from "./config.mjs";

// OAuth 2.1 client for the CLI: Authorization Code + PKCE over a 127.0.0.1
// loopback (RFC 8252), plus refresh-token rotation. No API key is ever pasted;
// the user approves in the browser using their existing Lettertrace session.

const CLIENT_ID = "lt_cli";
export const DEFAULT_SCOPE =
  "projects:read projects:write runs:read runs:trigger keys:read keys:write offline_access";

const b64url = (buf) => buf.toString("base64url");

/** Thrown when a resource has no usable credential; the caller may prompt a
 *  login for exactly that audience. `detail` explains why when the reason is
 *  something other than "you never logged in" — e.g. a stored token that
 *  predates a scope the deployment has since started requiring. */
export class NeedsLogin extends Error {
  constructor(resource, detail) {
    const how = `Run: lettertrace login${resource === "mcp" ? " --mcp" : ""}`;
    super(detail ? `${detail} ${how}` : `Not authenticated for "${resource}". ${how}`);
    this.name = "NeedsLogin";
    this.resource = resource;
    this.detail = detail ?? null;
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

async function tokenRequest(base, body) {
  const res = await fetch(`${base}/api/oauth/token`, {
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

function storeCredential(base, resource, tokens) {
  const cfg = loadConfig();
  cfg.base = base;
  const prev = cfg.credentials[resource] || {};
  cfg.credentials[resource] = {
    resource,
    access_token: tokens.access_token,
    // A refresh response without a new refresh_token keeps the previous one.
    refresh_token: tokens.refresh_token || prev.refresh_token || null,
    scope: tokens.scope ?? prev.scope ?? null,
    expires_at: Date.now() + (Number(tokens.expires_in) || 0) * 1000,
  };
  saveConfig(cfg);
  return cfg.credentials[resource];
}

/**
 * Probe whether the server accepts a given loopback redirect URI, WITHOUT
 * completing a login. The redirect URI is validated before PKCE, so a request
 * that omits code_challenge either 302-redirects (redirect accepted) or 400s
 * ("redirect URI is not registered"), and creates no pending request either way.
 */
async function redirectRejected(base, redirectUri) {
  try {
    const u = new URL(`${base}/api/oauth/authorize`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", CLIENT_ID);
    u.searchParams.set("redirect_uri", redirectUri);
    const res = await fetch(u, { redirect: "manual" });
    return res.status === 400;
  } catch {
    return false; // a network hiccup shouldn't block login; assume acceptable
  }
}

/**
 * Choose the loopback family the server actually accepts. Prefers 127.0.0.1 and
 * falls back to [::1] when the server rejects the IPv4 form, so the CLI works
 * whether the deployment registers/accepts one loopback or the other. --ipv6
 * forces [::1] and skips the probe.
 */
async function pickLoopback(base, ipv6) {
  const ipv4 = { host: "127.0.0.1", fmt: (p) => `http://127.0.0.1:${p}/callback` };
  const ip6 = { host: "::1", fmt: (p) => `http://[::1]:${p}/callback` };
  if (ipv6) return ip6;
  if ((await redirectRejected(base, ipv4.fmt(1))) && !(await redirectRejected(base, ip6.fmt(1)))) {
    process.stderr.write(
      "Note: the server rejected the 127.0.0.1 redirect; using the IPv6 loopback [::1].\n",
    );
    return ip6;
  }
  return ipv4;
}

/**
 * Run the full loopback Authorization Code + PKCE flow and store the tokens.
 * The loopback family (127.0.0.1 vs [::1]) is auto-detected against the server;
 * pass { ipv6: true } to force [::1].
 */
export async function login(base, resource = "v1", { scope = DEFAULT_SCOPE, ipv6 = false } = {}) {
  const loop = await pickLoopback(base, ipv6);
  const codeVerifier = b64url(crypto.randomBytes(48));
  const codeChallenge = b64url(crypto.createHash("sha256").update(codeVerifier).digest());
  const state = b64url(crypto.randomBytes(16));

  let redirectUri = "";
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const q = url.searchParams;
      const done = (title, body) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset=utf-8><title>${title}</title>` +
            `<body style="font-family:system-ui;max-width:30rem;margin:5rem auto;text-align:center">` +
            `<h1>${title}</h1><p>${body}</p></body>`,
        );
        server.close();
      };
      if (q.get("error")) {
        done("Authorization failed", `Error: ${q.get("error")}. You can close this tab.`);
        reject(new Error(`authorize error: ${q.get("error")}`));
        return;
      }
      if (q.get("state") !== state) {
        done("Authorization failed", "State mismatch. Close this tab.");
        reject(new Error("state mismatch"));
        return;
      }
      if (q.get("iss") && q.get("iss").replace(/\/+$/, "") !== base) {
        done("Authorization failed", "Issuer mismatch. Close this tab.");
        reject(new Error("issuer mismatch"));
        return;
      }
      done("You're signed in", "Return to your terminal. You can close this tab.");
      resolve(q.get("code"));
    });

    server.on("error", reject);
    server.listen(0, loop.host, () => {
      const port = server.address().port;
      redirectUri = loop.fmt(port);
      const authorize = new URL(`${base}/api/oauth/authorize`);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("client_id", CLIENT_ID);
      authorize.searchParams.set("redirect_uri", redirectUri);
      authorize.searchParams.set("scope", scope);
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("code_challenge", codeChallenge);
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("resource", resource);
      process.stderr.write(`\nOpening your browser to sign in or create your account (${resource.toUpperCase()} access)...\n`);
      process.stderr.write(`If it doesn't open, visit:\n  ${authorize.toString()}\n\n`);
      openBrowser(authorize.toString());
    });

    setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for authorization (5 min)"));
    }, 5 * 60 * 1000).unref();
  });

  const tokens = await tokenRequest(base, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  });
  return storeCredential(base, resource, tokens);
}

/**
 * A valid access token for the resource, refreshing if needed. Pass
 * force=true to skip the cache and rotate immediately (used after a 401, when a
 * token was revoked before its clock expiry).
 */
export async function getAccessToken(base, resource, { force = false } = {}) {
  const cfg = loadConfig();
  const cred = cfg.credentials[resource];
  if (!cred) throw new NeedsLogin(resource);

  const stillFresh = Date.now() < cred.expires_at - 30_000;
  if (!force && stillFresh) return cred.access_token;

  if (!cred.refresh_token) throw new NeedsLogin(resource);
  let tokens;
  try {
    tokens = await tokenRequest(base, {
      grant_type: "refresh_token",
      refresh_token: cred.refresh_token,
      client_id: CLIENT_ID,
    });
  } catch {
    // Refresh failed (expired, revoked, or reuse-detected). Force a fresh login.
    delete cfg.credentials[resource];
    saveConfig(cfg);
    throw new NeedsLogin(resource);
  }
  return storeCredential(base, resource, tokens).access_token;
}

/** Drop the stored credential for one audience without touching the others, so
 *  the next command re-runs the browser flow and re-consents from scratch. */
export function forget(resource) {
  const cfg = loadConfig();
  if (!cfg.credentials[resource]) return;
  delete cfg.credentials[resource];
  saveConfig(cfg);
}

export function logout() {
  const cfg = loadConfig();
  const tokens = [];
  for (const cred of Object.values(cfg.credentials)) {
    if (cred?.access_token) tokens.push(cred.access_token);
    if (cred?.refresh_token) tokens.push(cred.refresh_token);
  }
  cfg.credentials = {};
  saveConfig(cfg);
  return { base: cfg.base, tokens };
}

/** Best-effort server-side revocation of a token (RFC 7009). */
export async function revoke(base, token) {
  try {
    await fetch(`${base}/api/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch {
    /* revocation is best-effort */
  }
}
