import { describe, expect, it } from "vitest";
import { isShareLinkPath } from "@/lib/analytics-filter";

describe("isShareLinkPath", () => {
  it("matches a share link path", () => {
    expect(isShareLinkPath("/share/lt_share_abc123")).toBe(true);
  });

  it("does not match unrelated paths", () => {
    expect(isShareLinkPath("/dashboard/runs/abc123")).toBe(false);
    expect(isShareLinkPath("/")).toBe(false);
  });

  it("does not match the bare /share path with no trailing slash", () => {
    // Pins the intended boundary: only an actual token segment counts.
    expect(isShareLinkPath("/share")).toBe(false);
  });
});
