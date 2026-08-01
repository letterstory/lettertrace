// TEMPORARY: proves CI fails a red branch. Removed in the next commit.
import { describe, it, expect } from "vitest";
describe("ci canary", () => {
  it("fails on purpose", () => {
    expect(2 + 2).toBe(5);
  });
});
