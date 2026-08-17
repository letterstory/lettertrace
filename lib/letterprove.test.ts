import { describe, expect, it } from "vitest";
import { isFirstSignIn } from "./letterprove";

describe("isFirstSignIn", () => {
  // Supabase stamps both fields in the same request at signup, so they
  // coincide exactly once in an account's life.
  it("is true when the account was created by this very sign-in", () => {
    expect(
      isFirstSignIn({
        created_at: "2026-08-17T17:28:32.058221Z",
        last_sign_in_at: "2026-08-17T17:28:32.228147Z",
      }),
    ).toBe(true);
  });

  it("is false on every sign-in after the first", () => {
    expect(
      isFirstSignIn({
        created_at: "2026-08-17T17:28:32.058221Z",
        last_sign_in_at: "2026-08-18T09:04:11.000000Z",
      }),
    ).toBe(false);
  });

  // A signup counts as one signup forever. Reporting it again a minute later
  // would be a fabricated event, which is the one thing this pipeline must not
  // produce.
  it("is false once even a minute has passed", () => {
    expect(
      isFirstSignIn({
        created_at: "2026-08-17T17:28:32.000Z",
        last_sign_in_at: "2026-08-17T17:29:32.000Z",
      }),
    ).toBe(false);
  });

  it("tolerates the two writes not landing in the same instant", () => {
    expect(
      isFirstSignIn({
        created_at: "2026-08-17T17:28:32.000Z",
        last_sign_in_at: "2026-08-17T17:28:36.000Z",
      }),
    ).toBe(true);
  });

  // Missing or unparseable timestamps must read as "not a signup". Guessing
  // upward invents an event; guessing downward loses one, and only the first
  // is a false claim.
  it("refuses to guess when the record is incomplete", () => {
    expect(isFirstSignIn({})).toBe(false);
    expect(isFirstSignIn({ created_at: "2026-08-17T17:28:32Z" })).toBe(false);
    expect(isFirstSignIn({ created_at: "2026-08-17T17:28:32Z", last_sign_in_at: null })).toBe(false);
    expect(isFirstSignIn({ created_at: "not-a-date", last_sign_in_at: "also-not" })).toBe(false);
  });
});
