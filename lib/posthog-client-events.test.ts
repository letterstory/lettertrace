import { describe, expect, it } from "vitest";
import {
  identifyTraits,
  reportViewedProperties,
  shouldCaptureSignup,
  signupEventProperties,
  signupMethodOf,
} from "@/lib/posthog-client-events";

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial) values.set("lettertrace:posthog-signed-up", initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("browser analytics decisions", () => {
  it("identifies with the email and whether it is a work address", () => {
    expect(identifyTraits("Ada@Acme.com")).toEqual({
      email: "Ada@Acme.com",
      email_type: "work",
    });
    expect(identifyTraits("someone@gmail.com").email_type).toBe("personal");
    expect(identifyTraits(null)).toEqual({ email_type: "personal" });
  });

  it("reads the signup method Supabase recorded, and treats a missing one as email", () => {
    expect(signupMethodOf("google")).toBe("google");
    expect(signupMethodOf("  ")).toBe("email");
    expect(signupMethodOf(undefined)).toBe("email");
  });

  it("sends user_signed_up once per browser session, and not on a later sign-in", () => {
    const storage = memoryStorage();
    expect(shouldCaptureSignup(true, storage)).toBe(true);
    expect(shouldCaptureSignup(true, storage)).toBe(false);
    expect(shouldCaptureSignup(false, memoryStorage())).toBe(false);
    // No storage (private mode): a missing signup is better than a second one.
    expect(shouldCaptureSignup(true, null)).toBe(false);
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(shouldCaptureSignup(true, throwing)).toBe(false);
  });

  it("puts signup_method and email_type on the signup event", () => {
    expect(signupEventProperties("email", "a@gmail.com")).toEqual({
      signup_method: "email",
      email_type: "personal",
      channel: "dashboard",
    });
  });

  it("tags a viewed report with the org and whoever pays for it", () => {
    expect(
      reportViewedProperties({ orgId: "org-1", billingOwnerId: "owner-1", runId: "run-1" }),
    ).toEqual({
      org_id: "org-1",
      billing_owner_id: "owner-1",
      run_id: "run-1",
      channel: "dashboard",
    });
  });
});
