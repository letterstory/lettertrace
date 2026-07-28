import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateApiKey } from "@/lib/api-auth";
import {
  ENCRYPTION_UNAVAILABLE_MESSAGE,
  listProviderKeys,
  removeProviderKey,
  setProviderKey,
} from "@/lib/provider-keys";
import { GET as getKeysRoute } from "@/app/api/v1/keys/route";
import {
  DELETE as deleteKeyRoute,
  PUT as putKeyRoute,
} from "@/app/api/v1/keys/[provider]/route";

vi.mock("@/lib/api-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-auth")>()),
  authenticateApiKey: vi.fn(),
}));
vi.mock("@/lib/provider-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/provider-keys")>()),
  listProviderKeys: vi.fn(),
  setProviderKey: vi.fn(),
  removeProviderKey: vi.fn(),
}));

const AUTH_CTX = {
  supabase: {} as never,
  userId: "user-1",
  keyId: "key-1",
  tokenType: "api_key" as const,
  scopes: ["projects:read", "projects:write", "runs:read", "runs:trigger", "keys:read", "keys:write"],
  clientId: null,
  expiresAt: null,
  aud: null,
};

const STORED = {
  id: "pk-1",
  provider: "anthropic" as const,
  label: null,
  key_hint: "sk-ant-…4a9c",
  created_at: "2026-07-20T00:00:00Z",
};

const PLAINTEXT = "sk-ant-api03-definitely-not-a-real-key-4a9c";

function req(path: string, init?: RequestInit) {
  return new Request(`http://localhost${path}`, {
    headers: { authorization: "Bearer lt_live_test" },
    ...init,
  });
}

beforeEach(() => {
  vi.mocked(authenticateApiKey).mockReset().mockResolvedValue(AUTH_CTX);
  vi.mocked(listProviderKeys).mockReset();
  vi.mocked(setProviderKey).mockReset();
  vi.mocked(removeProviderKey).mockReset();
});

describe("GET /api/v1/keys", () => {
  it("401s without a valid credential", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null);
    const res = await getKeysRoute(new Request("http://localhost/api/v1/keys"));
    expect(res.status).toBe(401);
    expect(listProviderKeys).not.toHaveBeenCalled();
  });

  it("403s a token granted before keys:read existed", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({
      ...AUTH_CTX,
      tokenType: "oauth",
      clientId: "lt_cli",
      aud: "v1",
      scopes: ["projects:read", "runs:read"],
    });
    const res = await getKeysRoute(req("/api/v1/keys"));
    expect(res.status).toBe(403);
    // The machine-readable challenge is what lets the CLI tell "re-consent"
    // apart from "you're not allowed" and relaunch login by itself.
    expect(res.headers.get("WWW-Authenticate")).toContain("insufficient_scope");
    expect(res.headers.get("WWW-Authenticate")).toContain("keys:read");
  });

  it("returns stored hints plus the provider catalog", async () => {
    vi.mocked(listProviderKeys).mockResolvedValue([STORED]);
    const res = await getKeysRoute(req("/api/v1/keys"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys).toEqual([STORED]);
    // Shipped so clients never hardcode a provider list of their own.
    expect(body.providers.map((p: { id: string }) => p.id)).toContain("anthropic");
    expect(listProviderKeys).toHaveBeenCalledWith(AUTH_CTX.supabase, "user-1");
  });
});

describe("PUT /api/v1/keys/:provider", () => {
  const put = (provider: string, body?: unknown) =>
    putKeyRoute(
      req(`/api/v1/keys/${provider}`, {
        method: "PUT",
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: { provider } },
    );

  it("403s a token without keys:write, even one that may write projects", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({
      ...AUTH_CTX,
      tokenType: "oauth",
      clientId: "lt_cli",
      aud: "v1",
      scopes: ["projects:write", "runs:trigger"],
    });
    const res = await put("anthropic", { api_key: PLAINTEXT });
    expect(res.status).toBe(403);
    expect(setProviderKey).not.toHaveBeenCalled();
  });

  it("400s without a JSON body", async () => {
    const res = await put("anthropic");
    expect(res.status).toBe(400);
    expect(setProviderKey).not.toHaveBeenCalled();
  });

  it("400s on an unknown provider, naming the ones that work", async () => {
    vi.mocked(setProviderKey).mockResolvedValue({
      ok: false,
      code: "invalid",
      message: "Unknown provider. Supported: anthropic, openai.",
    });
    const res = await put("gemini", { api_key: PLAINTEXT });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("anthropic");
  });

  it("400s when the provider rejects the key", async () => {
    vi.mocked(setProviderKey).mockResolvedValue({
      ok: false,
      code: "unverified",
      message: "Invalid API key.",
    });
    const res = await put("anthropic", { api_key: PLAINTEXT });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid API key.");
  });

  // A broken deployment is a 503 an operator can act on — not a 400 that tells
  // the caller to go rotate a key the provider just accepted.
  it("503s on a misconfigured ENCRYPTION_KEY, not 400", async () => {
    vi.mocked(setProviderKey).mockResolvedValue({
      ok: false,
      code: "misconfigured",
      message: ENCRYPTION_UNAVAILABLE_MESSAGE,
    });
    const res = await put("anthropic", { api_key: PLAINTEXT });
    expect(res.status).toBe(503);
    const error = (await res.json()).error;
    expect(error).toContain("ENCRYPTION_KEY");
    expect(error).not.toMatch(/invalid api key/i);
  });

  it("500s when storage fails", async () => {
    vi.mocked(setProviderKey).mockResolvedValue({
      ok: false,
      code: "failed",
      message: "connection reset",
    });
    const res = await put("anthropic", { api_key: PLAINTEXT });
    expect(res.status).toBe(500);
  });

  it("stores the key and echoes back only the masked hint", async () => {
    vi.mocked(setProviderKey).mockResolvedValue({ ok: true, key: STORED });
    const res = await put("anthropic", { api_key: PLAINTEXT, label: "work" });
    expect(res.status).toBe(200);

    const raw = JSON.stringify(await res.json());
    expect(raw).toContain("sk-ant-…4a9c");
    // The response is the one place a key could trivially leak back out.
    expect(raw).not.toContain(PLAINTEXT);

    // The provider comes from the path; the secret only ever from the body.
    expect(setProviderKey).toHaveBeenCalledWith(AUTH_CTX.supabase, "user-1", {
      provider: "anthropic",
      apiKey: PLAINTEXT,
      label: "work",
    });
  });
});

describe("DELETE /api/v1/keys/:provider", () => {
  const del = (provider: string) =>
    deleteKeyRoute(req(`/api/v1/keys/${provider}`, { method: "DELETE" }), {
      params: { provider },
    });

  it("403s a token without keys:write", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({
      ...AUTH_CTX,
      tokenType: "oauth",
      clientId: "lt_cli",
      aud: "v1",
      scopes: ["keys:read"],
    });
    const res = await del("anthropic");
    expect(res.status).toBe(403);
    expect(removeProviderKey).not.toHaveBeenCalled();
  });

  it("400s an unknown provider before touching the database", async () => {
    const res = await del("gemini");
    expect(res.status).toBe(400);
    expect(removeProviderKey).not.toHaveBeenCalled();
  });

  it("404s when nothing was stored, so a no-op can't read as a revocation", async () => {
    vi.mocked(removeProviderKey).mockResolvedValue(null);
    const res = await del("openai");
    expect(res.status).toBe(404);
  });

  it("removes the key and reports which one went", async () => {
    vi.mocked(removeProviderKey).mockResolvedValue(STORED);
    const res = await del("anthropic");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.key.key_hint).toBe("sk-ant-…4a9c");
    expect(removeProviderKey).toHaveBeenCalledWith(AUTH_CTX.supabase, "user-1", "anthropic");
  });
});
