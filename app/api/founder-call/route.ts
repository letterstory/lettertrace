import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Records that the founder-call offer has been made to the signed-in user.
 *
 * Write-once by intent: the update is conditional on the column still being
 * null, so a double-render, a second tab, or a retried request cannot move the
 * timestamp. It is the same "exactly once per person" lock as admin_alerted_at.
 *
 * Takes no request body. Whose row to mark comes from the session and nothing
 * else — accepting a user id here would let any signed-in user burn another
 * user's offer.
 *
 * Always answers 200 once authenticated, including when the row was already
 * marked, because the caller has nothing useful to do with a failure: the
 * dialog is already on screen and must not be torn down over a bookkeeping
 * write.
 */
export async function POST() {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { error } = await supabase
    .from("profiles")
    .update({ founder_call_prompted_at: new Date().toISOString() })
    .eq("id", user.id)
    .is("founder_call_prompted_at", null);

  if (error) {
    console.error("[lettertrace:founder-call] could not record the offer", error.message);
  }

  return NextResponse.json({ ok: true });
}
