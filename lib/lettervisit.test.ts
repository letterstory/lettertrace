import { afterEach, describe, expect, it, vi } from "vitest";

describe("lettervisit", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("reports public pages only, never the product", async () => {
    const { isLettervisitPath } = await import("./lettervisit");
    for (const p of ["/", "/blog", "/blog/some-post", "/privacy", "/terms"]) expect(isLettervisitPath(p)).toBe(true);
    for (const p of ["/dashboard", "/login", "/admin", "/oauth/consent", "/blogger", "/api/v1/x"])
      expect(isLettervisitPath(p)).toBe(false);
  });

  it("forwards crawlers and assistants, not browsers", async () => {
    const { isAgentRequest } = await import("./lettervisit");
    expect(isAgentRequest("Mozilla/5.0 (compatible; GPTBot/1.2)", null)).toBe(true);
    expect(isAgentRequest("Mozilla/5.0 ... Claude-User/1.0", null)).toBe(true);
    expect(isAgentRequest("MistralAI-User/1.0", null)).toBe(true);
    expect(isAgentRequest("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", null)).toBe(false);
    expect(isAgentRequest("Mozilla/5.0 Chrome/130.0", "agent.example")).toBe(true);
  });

  it("is inert without a key, and posts the site key when set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const input = { userAgent: "GPTBot/1.2", ip: "1.2.3.4", path: "/blog/x", host: "lettertrace.com", signatureAgent: null };

    vi.stubEnv("NEXT_PUBLIC_LETTERVISIT_KEY", "");
    await (await import("./lettervisit")).forwardAgentVisit(input);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_LETTERVISIT_KEY", "lv_pub_test");
    await (await import("./lettervisit")).forwardAgentVisit(input);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://lettervisit.com/api/v1/agent-visit");
    expect(JSON.parse(init.body)).toEqual({
      k: "lv_pub_test",
      ua: "GPTBot/1.2",
      ip: "1.2.3.4",
      path: "/blog/x",
      host: "lettertrace.com",
      signature_agent: null,
    });
  });
});
