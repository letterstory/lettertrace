import type { SupabaseClient } from "@supabase/supabase-js";
import { sendAdminAlert, signupAlert, adminAlertEmails } from "@/lib/notify";

/**
 * Tell the operator about a new account, exactly once.
 *
 * "Exactly once" is the whole difficulty. Every signup path lands on
 * /auth/callback, but so does every OAuth SIGN-IN, and a confirmation link is
 * routinely opened twice — by the person and by their mail client's link
 * scanner. Deciding on "was this account created recently?" would mail the
 * operator two or three times for one signup.
 *
 * So the claim is a guarded update: stamp admin_alerted_at only where it is
 * still null, and send only if that write actually changed a row. Two
 * concurrent callbacks race, one wins, the loser sends nothing. It is the same
 * shape as settleAbandonedRun, and for the same reason — the database is the
 * only thing both requests can agree on.
 *
 * Requires a service-role client: `authenticated` may only update
 * active_project_id on profiles, by design.
 */
export async function alertNewSignup(
  admin: SupabaseClient,
  user: { id: string; email?: string | null; created_at?: string },
): Promise<"alerted" | "already-alerted" | "not-configured" | "failed"> {
  // Claim the alert before doing anything slow. Cheap when unconfigured: skip
  // the write entirely so a deployment with no alerting doesn't take a round
  // trip on every sign-in.
  if (adminAlertEmails().length === 0) return "not-configured";

  const { data, error } = await admin
    .from("profiles")
    .update({ admin_alerted_at: new Date().toISOString() })
    .eq("id", user.id)
    .is("admin_alerted_at", null)
    .select("id");

  // A failed claim is NOT an already-claimed one. Reading a null result as
  // "someone else got there first" is how a deployment running an older schema
  // would go quiet forever: the column is missing, every update errors, and
  // every signup looks like a duplicate. Say so instead.
  if (error) {
    console.error(`[notify] could not claim the signup alert: ${error.message} (${error.code})`);
    return "failed";
  }
  if (!(data ?? []).length) return "already-alerted";

  await sendAdminAlert(signupAlert(user));
  // Deliberately not un-stamping on a send failure: a retry loop that mails the
  // operator every time someone signs in is worse than one missed alert, and
  // the failure is already on the server log.
  return "alerted";
}
