import { describe, it, expect } from "vitest";
import { resolveRedirectBase, safePath } from "@/lib/utils";

describe("resolveRedirectBase", () => {
  const PROD = "https://lettertrace.com";
  const LOCAL = "http://localhost:3000";

  // The outage this exists to prevent: NEXT_PUBLIC_SITE_URL left at localhost
  // in production sent every signed-in user to their own machine, where the
  // cookies just set on the real domain don't exist. Silent, and it looks
  // exactly like "sign-in doesn't work".
  it("ignores a loopback site URL when the request came from a real domain", () => {
    expect(resolveRedirectBase(LOCAL, PROD)).toBe(PROD);
    expect(resolveRedirectBase("http://127.0.0.1:3000", PROD)).toBe(PROD);
    expect(resolveRedirectBase("http://localhost", PROD)).toBe(PROD);
  });

  it("still honours a loopback site URL for a genuinely local request", () => {
    expect(resolveRedirectBase(LOCAL, LOCAL)).toBe(LOCAL);
    expect(resolveRedirectBase(LOCAL, "http://127.0.0.1:3000")).toBe(LOCAL);
  });

  it("prefers the configured URL over the request origin behind a proxy", () => {
    // The case the configured value exists for: Vercel's internal host.
    expect(resolveRedirectBase(PROD, "https://lettertrace-abc123.vercel.app")).toBe(PROD);
  });

  it("falls back to the origin when nothing is configured", () => {
    expect(resolveRedirectBase(undefined, PROD)).toBe(PROD);
    expect(resolveRedirectBase(null, PROD)).toBe(PROD);
    expect(resolveRedirectBase("", PROD)).toBe(PROD);
    expect(resolveRedirectBase("   ", PROD)).toBe(PROD);
  });

  it("falls back to the origin rather than breaking on a malformed value", () => {
    expect(resolveRedirectBase("lettertrace.com", PROD)).toBe(PROD); // no scheme
    expect(resolveRedirectBase("not a url", PROD)).toBe(PROD);
  });

  it("tolerates surrounding whitespace in the env var", () => {
    expect(resolveRedirectBase(`  ${PROD}  `, "https://internal.vercel.app")).toBe(PROD);
  });

  it("treats ::1 as loopback too", () => {
    expect(resolveRedirectBase("http://[::1]:3000", PROD)).toBe(PROD);
  });

  it("does not mistake a hostname that merely contains 'localhost'", () => {
    const lookalike = "https://localhost.evil.com";
    expect(resolveRedirectBase(lookalike, PROD)).toBe(lookalike);
  });
});

describe("safePath", () => {
  it("allows same-origin paths", () => {
    expect(safePath("/dashboard/runs")).toBe("/dashboard/runs");
  });

  it("rejects protocol-relative and backslash open-redirect tricks", () => {
    expect(safePath("//evil.com")).toBe("/dashboard");
    expect(safePath("/\\evil.com")).toBe("/dashboard");
    expect(safePath("https://evil.com")).toBe("/dashboard");
  });

  it("falls back for non-strings", () => {
    expect(safePath(null)).toBe("/dashboard");
    expect(safePath(undefined)).toBe("/dashboard");
    expect(safePath("", "/somewhere")).toBe("/somewhere");
  });
});
