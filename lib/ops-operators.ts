import { createServiceClient } from "@/lib/supabase/service";
import { adminGate, adminUserIds, adminEmails, type AdminGate } from "@/lib/admin";

/**
 * Who is currently an operator, resolved back to real accounts.
 *
 * This exists because of a genuinely awkward property of the deployment: a
 * Vercel variable marked "sensitive" is write-only. It can never be read back,
 * not through the dashboard and not through the API — so adding one person to
 * ADMIN_USER_IDS means retyping the entire list from memory, and getting it
 * wrong silently locks somebody out.
 *
 * But the RUNNING APP can read it. It is an ordinary environment variable in
 * the process; only the management UI hides it. So the page shows you the list
 * you cannot otherwise see, which turns "retype it blind" into "copy, append,
 * paste".
 *
 * Resolving each entry to an account does the other half of the job: a
 * mistyped id belongs to nobody, and that is invisible in a config file but
 * obvious here. On the email gate it surfaces something sharper still — an
 * allowlisted address with no account is the claimable hole that ADMIN_USER_IDS
 * exists to close, and now it says so on the page rather than in a commit
 * message nobody rereads.
 */

export interface OperatorEntry {
  /** The literal value configured — an id, or an address on the email gate. */
  value: string;
  email: string | null;
  /** False when nothing in auth.users matches: a typo, or a claimable address. */
  resolved: boolean;
  lastSignInAt: string | null;
}

export interface OperatorRoster {
  gate: AdminGate;
  entries: OperatorEntry[];
  /** The current setting, ready to copy, extend and paste back. */
  currentValue: string;
  /** Set when accounts could not be read, so the page says so rather than
   *  rendering every operator as unresolved and implying they are all typos. */
  degraded: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function operatorRoster(): Promise<OperatorRoster> {
  const gate = adminGate();
  const values = gate === "user-id" ? adminUserIds() : gate === "email" ? adminEmails() : [];
  const currentValue = values.join(",");
  const base: OperatorRoster = { gate, entries: [], currentValue, degraded: null };
  if (values.length === 0) return base;

  try {
    const admin = createServiceClient();

    if (gate === "user-id") {
      // Looked up one at a time rather than by listing every user: exact, and
      // it stays cheap on a deployment with a large user table, since the
      // operator list is always short.
      const entries = await Promise.all(
        values.map(async (value): Promise<OperatorEntry> => {
          if (!UUID.test(value)) {
            // Not a uuid at all — almost certainly an address pasted into the
            // id list, which would match nobody and grant nothing.
            return { value, email: null, resolved: false, lastSignInAt: null };
          }
          const { data, error } = await admin.auth.admin.getUserById(value);
          if (error || !data?.user) return { value, email: null, resolved: false, lastSignInAt: null };
          return {
            value,
            email: data.user.email ?? null,
            resolved: true,
            lastSignInAt: data.user.last_sign_in_at ?? null,
          };
        }),
      );
      return { ...base, entries };
    }

    // Email gate: there is no lookup-by-address, so scan. Bounded, and the
    // page reports a scan that ran out rather than pretending it was complete.
    const seen = new Map<string, { email: string; lastSignInAt: string | null }>();
    let page = 1;
    let exhausted = false;
    while (page <= 10) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw error;
      const users = data?.users ?? [];
      for (const u of users) {
        if (u.email) {
          seen.set(u.email.toLowerCase(), {
            email: u.email,
            lastSignInAt: u.last_sign_in_at ?? null,
          });
        }
      }
      if (users.length < 1000) {
        exhausted = true;
        break;
      }
      page += 1;
    }
    const entries = values.map((value): OperatorEntry => {
      const hit = seen.get(value);
      return {
        value,
        email: hit?.email ?? null,
        resolved: Boolean(hit),
        lastSignInAt: hit?.lastSignInAt ?? null,
      };
    });
    return {
      ...base,
      entries,
      degraded: exhausted ? null : "more accounts exist than were scanned",
    };
  } catch (err) {
    return {
      ...base,
      entries: values.map((value) => ({ value, email: null, resolved: false, lastSignInAt: null })),
      degraded: err instanceof Error ? err.message : "could not read accounts",
    };
  }
}
