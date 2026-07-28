import { forget, getAccessToken, NeedsLogin } from "./oauth.mjs";

// Thin REST client for the Lettertrace v1 API. Every call carries an OAuth
// access token bound to the "v1" audience, transparently refreshed when it has
// expired. If the server rejects a token that our clock still thought was valid
// (e.g. it was revoked), we force one rotation and retry a single time.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function rest(base, method, pathname, { query, body } = {}) {
  const url = new URL(`${base}/api/v1${pathname}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const send = (token) =>
    fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  let res = await send(await getAccessToken(base, "v1"));
  if (res.status === 401) {
    // The token was rejected despite passing our local expiry check. Force a
    // rotation (or NeedsLogin) and try exactly once more.
    res = await send(await getAccessToken(base, "v1", { force: true }));
  }

  // A token minted before the deployment started requiring a scope is a
  // permanent 403 no amount of refreshing fixes — the scope set is baked into
  // the grant the user approved. Discard it and surface NeedsLogin so the
  // caller re-runs consent, which is the only place the wider scope can be
  // granted. Detected from the RFC 6750 challenge, not the prose message.
  if (res.status === 403) {
    const challenge = res.headers.get("www-authenticate") ?? "";
    if (challenge.includes("insufficient_scope")) {
      forget("v1");
      throw new NeedsLogin(
        "v1",
        "Your saved sign-in predates a permission this command needs.",
      );
    }
  }

  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, json?.error, json?.error || `HTTP ${res.status}`);
  }
  return json;
}
