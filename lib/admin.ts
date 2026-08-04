import { createClient } from "@/lib/supabase/server";

/**
 * Who may see the operations dashboard.
 *
 * An env allowlist rather than a database role, for two reasons. This
 * repository is public, so a hardcoded list of Letterstory addresses would be
 * both wrong and permanent — a self-hoster sets their own and nothing about
 * our team ships in the source. And it needs no migration, no admin UI to
 * manage admins, and no way to accidentally grant it through the product.
 *
 * Empty by default, which means NOBODY is an operator. A fresh deployment has
 * no admin surface at all until someone deliberately names one: the failure
 * mode of an empty list is a locked door, and of a permissive default is an
 * open one.
 *
 * ---------------------------------------------------------------------------
 * WHY IDS ARE THE REAL CONTROL AND EMAIL IS THE FALLBACK
 * ---------------------------------------------------------------------------
 * An email address is a CLAIMABLE identifier. Signup on this deployment issues
 * a session immediately — email confirmation is off, which is also why the
 * signup alert hangs off the dashboard layout rather than /auth/callback — so
 * anyone who registers `someone@letterstory.com` holds a validated session
 * whose email IS that address. If an allowlisted address has no account yet,
 * the allowlist is protecting nothing: the attacker just signs up as them.
 *
 * Worse, the obvious defence does not work here. Supabase stamps
 * `email_confirmed_at` at signup time when confirmation is disabled, so a
 * freshly claimed address reports itself as confirmed. Checking that field
 * would be pure false comfort — verified by probing the live project.
 *
 * A user id cannot be claimed. It is assigned by the auth server, and nobody
 * can register their way into an existing one. So when ADMIN_USER_IDS is set
 * it is the ONLY thing consulted, and the email list is ignored entirely
 * rather than unioned — a union would preserve exactly the weakness the ids
 * exist to remove.
 *
 * Email matching stays supported because it is what makes this usable for a
 * self-hoster on day one. It is safe on the condition that every allowlisted
 * address already has an account, since an existing address cannot be
 * re-registered. That is a real condition, and it is why ids are preferred.
 */
export function adminUserIds(): string[] {
  return (process.env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
}

export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Is this user id an operator? Empty list means no. */
export function isAdminUserId(id: string | null | undefined): boolean {
  const value = id?.trim().toLowerCase();
  if (!value) return false;
  const allowed = adminUserIds();
  if (allowed.length === 0) return false;
  return allowed.includes(value);
}

/** Is this address an operator? Case-insensitive; empty list means no. */
export function isAdminEmail(email: string | null | undefined): boolean {
  const address = email?.trim().toLowerCase();
  if (!address) return false;
  const allowed = adminEmails();
  if (allowed.length === 0) return false;
  return allowed.includes(address);
}

/** Which mechanism is in force, so the dashboard can say so plainly. */
export type AdminGate = "user-id" | "email" | "none";

export function adminGate(): AdminGate {
  if (adminUserIds().length > 0) return "user-id";
  if (adminEmails().length > 0) return "email";
  return "none";
}

/**
 * The signed-in user, if they are an operator. Null otherwise.
 *
 * Callers treat null as "not found" rather than "forbidden" — an operations
 * dashboard that announces its own existence to everyone who guesses the URL
 * is telling people where to push. The URL is not a secret and is not doing
 * any of the work here; this check is.
 *
 * Uses getUser(), never getSession(). getUser() revalidates the token with the
 * auth server; getSession() decodes whatever the cookie says. The difference
 * is the whole gate.
 */
export async function requireAdmin(): Promise<{ email: string; gate: AdminGate } | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const gate = adminGate();
  if (gate === "none") return null;
  const allowed = gate === "user-id" ? isAdminUserId(user.id) : isAdminEmail(user.email);
  if (!allowed) return null;

  return { email: user.email ?? user.id, gate };
}
