import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyEmail, emailDomain } from "@/lib/growth";
import { companyFromDomain } from "@/lib/accounts";

const TIMEOUT_MS = 10_000;

// A brand-new account reaches the dashboard within moments of signing up
// (email confirmation is off by default). This window exists only to guard
// against the migration that added cardinal_signup_sent_at: that column is
// NULL for every account that already existed, so without an age check the
// column's rollout would read every current user as "never sent" and fire
// Cardinal for all of them on their next dashboard visit, not just new
// signups. A day comfortably covers slower paths (OAuth redirects, an
// install with email confirmation on) while still rejecting any pre-existing
// account.
const SIGNUP_WINDOW_DAYS = 1;

export type CardinalSignupOutcome =
  | "sent"
  | "already-sent"
  | "not-configured"
  | "no-email"
  | "too-old"
  | "failed";

function config(): { url: string; token: string } | null {
  const url = process.env.CARDINAL_SIGNUP_WEBHOOK_URL?.trim();
  const token = process.env.CARDINAL_SIGNUP_WEBHOOK_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

export function cardinalSignupConfigured(): boolean {
  return config() !== null;
}

/** Is this account new enough to still count as "just signed up"? */
export function withinCardinalSignupWindow(
  createdAt: string | undefined,
  now = Date.now(),
): boolean {
  if (!createdAt) return false;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return false;
  const age = now - created;
  // A clock-skewed future timestamp is still a new account, not an old one.
  return age < SIGNUP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * The user's own company, guessed from a work email's domain
 * ("alice@acme.io" -> "Acme"). Null for personal/burner addresses (Gmail,
 * etc.) — there is nothing to guess from those. Same heuristic the admin
 * accounts page uses (lib/accounts.ts), applied here without its
 * already-tracked-brand fallback, which doesn't apply to a fresh signup.
 */
function companyFromEmail(email: string): string | null {
  if (classifyEmail(email) !== "work") return null;
  return companyFromDomain(emailDomain(email));
}

/**
 * Send Cardinal one lead for a new account, at most once.
 *
 * The guarded update is the lock. The dashboard may render twice, or two tabs
 * may open at the same time; only the request that stamps the profile sends the
 * webhook. A failed Cardinal call is not un-stamped: signup enrichment is
 * best-effort and must never turn dashboard access into a retry loop.
 *
 * first_name/last_name aren't collected anywhere in this app today (plain
 * email/password signup, and OAuth metadata goes unread) — the parameters
 * exist for whenever a future caller has them, and are simply omitted from
 * the payload until then.
 *
 * Requires a service-role client: browser sessions may only update
 * active_project_id on profiles.
 */
export async function sendCardinalSignup(
  service: SupabaseClient,
  user: {
    id: string;
    email?: string | null;
    created_at: string;
    first_name?: string | null;
    last_name?: string | null;
  },
): Promise<CardinalSignupOutcome> {
  const c = config();
  if (!c) return "not-configured";

  const email = user.email?.trim().toLowerCase();
  if (!email) return "no-email";

  if (!withinCardinalSignupWindow(user.created_at)) return "too-old";

  const { data, error } = await service
    .from("profiles")
    .update({ cardinal_signup_sent_at: new Date().toISOString() })
    .eq("id", user.id)
    .is("cardinal_signup_sent_at", null)
    .select("id");

  if (error) {
    console.error(`[cardinal] could not claim signup webhook: ${error.message} (${error.code})`);
    return "failed";
  }
  if (!(data ?? []).length) return "already-sent";

  const payload: Record<string, string> = { email };
  const firstName = user.first_name?.trim();
  const lastName = user.last_name?.trim();
  const company = companyFromEmail(email);
  if (firstName) payload.first_name = firstName;
  if (lastName) payload.last_name = lastName;
  if (company) payload.company = company;

  try {
    const res = await fetch(c.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${c.token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[cardinal] signup webhook rejected (${res.status}): ${detail.slice(0, 300)}`);
      return "failed";
    }
    return "sent";
  } catch (e) {
    console.error(
      `[cardinal] signup webhook failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return "failed";
  }
}
