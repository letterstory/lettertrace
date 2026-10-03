import { classifyEmail, type EmailClass } from "@/lib/growth";

/**
 * Decisions for the browser-side PostHog calls. Kept free of posthog-js so
 * the test runner (Node, no DOM) can pin them. The components only apply
 * what these functions return.
 */

const SIGNUP_FLAG = "lettertrace:posthog-signed-up";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function emailTypeOf(email: string | null | undefined): EmailClass {
  return classifyEmail(email);
}

/** Supabase names the method on app_metadata.provider. Email signups say "email". */
export function signupMethodOf(provider: unknown): string {
  return typeof provider === "string" && provider.trim() ? provider.trim() : "email";
}

export function identifyTraits(email: string | null | undefined): {
  email?: string;
  email_type: EmailClass;
} {
  const email_type = emailTypeOf(email);
  const trimmed = email?.trim();
  return trimmed ? { email: trimmed, email_type } : { email_type };
}

/**
 * One signup event per browser session. A refresh of the first session must
 * not count as a second signup; a missing storage (private mode) under-reports
 * rather than inventing one. Same direction Letterprove takes, for the same
 * reason: an extra signup is a false claim.
 */
export function shouldCaptureSignup(
  firstSignIn: boolean,
  storage: StorageLike | null,
): boolean {
  if (!firstSignIn || !storage) return false;
  try {
    if (storage.getItem(SIGNUP_FLAG)) return false;
    storage.setItem(SIGNUP_FLAG, "1");
    return true;
  } catch {
    return false;
  }
}

export function signupEventProperties(signupMethod: string, email: string | null | undefined) {
  return {
    signup_method: signupMethod,
    email_type: emailTypeOf(email),
    channel: "dashboard",
  };
}

export function reportViewedProperties(input: {
  orgId: string;
  billingOwnerId: string;
  runId: string;
}) {
  return {
    org_id: input.orgId,
    billing_owner_id: input.billingOwnerId,
    run_id: input.runId,
    channel: "dashboard",
  };
}
