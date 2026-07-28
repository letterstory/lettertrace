import { describe, it, expect } from "vitest";
import { apiActor, clientLabel, deriveChannel, requestMeta } from "@/lib/activity";
import type { ApiAuthContext } from "@/lib/api-auth";

// Pure attribution helpers. The write path (logActivity) is a best-effort
// side effect against Supabase and isn't unit-tested here; these functions are
// the logic that decides who/what/where an event is attributed to.

function ctx(over: Partial<ApiAuthContext>): ApiAuthContext {
  return {
    supabase: {} as ApiAuthContext["supabase"],
    userId: "user-1",
    keyId: "key-1",
    tokenType: "api_key",
    scopes: ["projects:read"],
    clientId: null,
    expiresAt: null,
    aud: null,
    ...over,
  };
}

describe("clientLabel", () => {
  it("names the first-party CLI, passes others through, defaults null", () => {
    expect(clientLabel("lt_cli")).toBe("Lettertrace CLI & MCP");
    expect(clientLabel("some_third_party")).toBe("some_third_party");
    expect(clientLabel(null)).toBe("OAuth client");
    expect(clientLabel(undefined)).toBe("OAuth client");
  });
});

describe("deriveChannel", () => {
  it("routes the MCP surface to the mcp channel regardless of client", () => {
    expect(deriveChannel({ tokenType: "oauth", clientId: "lt_cli", surface: "mcp" })).toBe("mcp");
    expect(deriveChannel({ tokenType: "api_key", clientId: null, surface: "mcp" })).toBe("mcp");
  });

  it("splits the REST surface into cli (first-party) vs api", () => {
    expect(deriveChannel({ tokenType: "oauth", clientId: "lt_cli", surface: "v1" })).toBe("cli");
    expect(deriveChannel({ tokenType: "oauth", clientId: "other", surface: "v1" })).toBe("api");
    expect(deriveChannel({ tokenType: "api_key", clientId: null, surface: "v1" })).toBe("api");
  });
});

describe("apiActor", () => {
  it("describes a classic API key", () => {
    expect(apiActor(ctx({ tokenType: "api_key", clientId: null }), "v1")).toEqual({
      actorType: "api_key",
      actorId: "key-1",
      actorLabel: "API key",
      channel: "api",
    });
  });

  it("describes the first-party CLI OAuth token", () => {
    expect(
      apiActor(ctx({ tokenType: "oauth", clientId: "lt_cli" }), "v1"),
    ).toEqual({
      actorType: "oauth",
      actorId: "key-1",
      actorLabel: "Lettertrace CLI & MCP",
      channel: "cli",
    });
  });

  it("routes an OAuth MCP token to the mcp channel", () => {
    expect(apiActor(ctx({ tokenType: "oauth", clientId: "third" }), "mcp").channel).toBe("mcp");
  });
});

describe("requestMeta", () => {
  it("pulls method, path, first forwarded ip, and user agent", () => {
    const req = new Request("https://app.test/api/v1/logs?page=2", {
      method: "GET",
      headers: {
        "x-forwarded-for": "1.2.3.4, 5.6.7.8",
        "user-agent": "lettertrace-cli/1.0",
      },
    });
    expect(requestMeta(req)).toEqual({
      method: "GET",
      path: "/api/v1/logs",
      ip: "1.2.3.4",
      userAgent: "lettertrace-cli/1.0",
    });
  });

  it("falls back to x-real-ip and tolerates missing headers", () => {
    const req = new Request("https://app.test/api/mcp", {
      method: "POST",
      headers: { "x-real-ip": "9.9.9.9" },
    });
    const meta = requestMeta(req);
    expect(meta.method).toBe("POST");
    expect(meta.path).toBe("/api/mcp");
    expect(meta.ip).toBe("9.9.9.9");
    expect(meta.userAgent).toBeNull();
  });
});
