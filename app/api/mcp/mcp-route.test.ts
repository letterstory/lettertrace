import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateApiKey } from "@/lib/api-auth";
import { POST as mcpPost } from "@/app/api/mcp/[transport]/route";

vi.mock("@/lib/api-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-auth")>()),
  authenticateApiKey: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: vi.fn() }));
// lib/data uses React cache(), which doesn't exist in the vitest environment.
vi.mock("@/lib/data", () => ({ getProjects: vi.fn() }));

function rpc(body: unknown, token?: string) {
  return new Request("http://localhost/api/mcp/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "vitest", version: "0.0.0" },
  },
};

beforeEach(() => {
  vi.mocked(authenticateApiKey).mockReset();
});

describe("MCP endpoint auth", () => {
  it("401s without a bearer token", async () => {
    const res = await mcpPost(rpc(INITIALIZE));
    expect(res.status).toBe(401);
    expect(authenticateApiKey).toHaveBeenCalledWith(undefined);
  });

  it("401s with an invalid key", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null);
    const res = await mcpPost(rpc(INITIALIZE, "lt_live_bogus"));
    expect(res.status).toBe(401);
  });

  it("completes the initialize handshake with a valid key", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({
      supabase: {} as never,
      userId: "user-1",
      keyId: "key-1",
    });
    const res = await mcpPost(rpc(INITIALIZE, "lt_live_valid"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"lettertrace"'); // serverInfo.name
    expect(text).toContain('"tools"'); // capabilities advertise tools
  });
});
