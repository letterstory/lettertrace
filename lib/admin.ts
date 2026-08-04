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
 * The list is empty by default, which means NOBODY is an operator. A fresh
 * deployment has no admin surface at all until someone deliberately names one.
 * That is the right default for a public repo: the failure mode of an empty
 * list is a locked door, and of a permissive default is an open one.
 */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Is this address an operator? Case-insensitive; empty list means no. */
export function isAdminEmail(email: string | null | undefined): boolean {
  const address = email?.trim().toLowerCase();
  if (!address) return false;
  const allowed = adminEmails();
  if (allowed.length === 0) return false;
  return allowed.includes(address);
}

/**
 * The signed-in user, if they are an operator. Null otherwise.
 *
 * Callers treat null as "not found" rather than "forbidden" — an operations
 * dashboard that announces its own existence to everyone who guesses the URL
 * is telling people where to push. There is nothing secret in the CODE, but
 * there is no reason to confirm the route resolves.
 */
export async function requireAdmin(): Promise<{ email: string } | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email || !isAdminEmail(user.email)) return null;
  return { email: user.email };
}
