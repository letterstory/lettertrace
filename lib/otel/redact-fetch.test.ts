import { describe, expect, it } from "vitest";
import { redactSpanName, redactUrl } from "./redact-fetch";

const SUPABASE = "https://fimiewdxsgsxspvgunoh.supabase.co";
const KEY_HASH = "c0340221154747475ec6e13d4786ea19865d88bc532c2fbe541e943c3439348c";
const UUID = "7f6c1d2e-4b3a-4c5d-9e8f-0a1b2c3d4e5f";

describe("redactUrl", () => {
  it("drops the query string, which is where the identifiers are", () => {
    expect(redactUrl(`${SUPABASE}/rest/v1/api_keys?select=id,user_id&key_hash=eq.${KEY_HASH}`)).toBe(
      `${SUPABASE}/rest/v1/api_keys`,
    );
  });

  it("collapses a uuid path segment", () => {
    expect(redactUrl(`https://lettertrace.com/api/v1/runs/${UUID}/responses`)).toBe(
      "https://lettertrace.com/api/v1/runs/:id/responses",
    );
  });

  it("collapses a long hex or numeric segment", () => {
    expect(redactUrl(`${SUPABASE}/storage/v1/object/${KEY_HASH}`)).toBe(
      `${SUPABASE}/storage/v1/object/:id`,
    );
    expect(redactUrl("https://api.example.com/v1/accounts/1234567890")).toBe(
      "https://api.example.com/v1/accounts/:id",
    );
  });

  it("leaves an ordinary provider endpoint alone", () => {
    expect(redactUrl("https://api.perplexity.ai/v1/sonar")).toBe("https://api.perplexity.ai/v1/sonar");
    expect(redactUrl("https://api.concentrate.ai/v1/messages")).toBe(
      "https://api.concentrate.ai/v1/messages",
    );
  });

  it("does not mistake a short hex path for an id", () => {
    expect(redactUrl("https://api.example.com/v1/abc123")).toBe("https://api.example.com/v1/abc123");
  });

  it("returns anything unparseable unchanged", () => {
    expect(redactUrl("not a url")).toBe("not a url");
  });
});

describe("redactSpanName", () => {
  it("rewrites a fetch span name", () => {
    expect(
      redactSpanName(`fetch GET ${SUPABASE}/rest/v1/api_keys?select=id&key_hash=eq.${KEY_HASH}`),
    ).toBe(`fetch GET ${SUPABASE}/rest/v1/api_keys`);
  });

  it("keeps the method", () => {
    expect(redactSpanName(`fetch PATCH ${SUPABASE}/rest/v1/api_keys?id=eq.${UUID}`)).toBe(
      `fetch PATCH ${SUPABASE}/rest/v1/api_keys`,
    );
  });

  it("leaves the hand-placed and next.js spans untouched", () => {
    for (const name of [
      "llm.query",
      "run.execute",
      "cron.run",
      "GET /api/v1/runs/[id]/status/route",
      "RSC GET /login",
      "resolve page components",
    ]) {
      expect(redactSpanName(name)).toBe(name);
    }
  });
});
