"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/admin";
import { createServiceClient } from "@/lib/supabase/service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Grant or revoke complimentary access for one account (profiles.is_comped).
 *
 * A comped account runs on the operator's shared trial keys with both free-tier
 * ceilings lifted — genuinely uncapped spend on the operator's bill — so this is
 * the most privileged write in the product. Two things guard it:
 *
 *   1. requireAdmin() is re-checked HERE, inside the action. A server action is a
 *      publicly reachable POST endpoint; the gate on the page that renders the
 *      button does nothing for a request that skips the page. The check that
 *      matters is this one.
 *   2. The write goes through the service-role client, which is how it clears the
 *      guard_profiles trigger (that trigger pins is_comped for 'authenticated'/
 *      'anon' sessions precisely so a user can't self-comp — see schema.sql).
 *
 * Prefer setting ADMIN_USER_IDS over ADMIN_EMAILS for the deployment that
 * exposes this: an email is a claimable identifier (signup issues a session with
 * no confirmation), a user id is not. See lib/admin.ts.
 */
export async function setAccountComped(formData: FormData) {
  const admin = await requireAdmin();
  if (!admin) throw new Error("Not authorized.");

  const userId = String(formData.get("userId") ?? "");
  if (!UUID_RE.test(userId)) throw new Error("Invalid account id.");
  const comped = formData.get("comped") === "true";

  const svc = createServiceClient();
  const { error } = await svc.from("profiles").update({ is_comped: comped }).eq("id", userId);
  if (error) throw new Error(error.message);

  revalidatePath(`/admin/accounts/${userId}`);
}
