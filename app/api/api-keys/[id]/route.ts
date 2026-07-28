import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logDashboard } from "@/lib/activity";

// DELETE /api/api-keys/:id — revoke a Lettertrace API key.
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { error } = await supabase
    .from("api_keys")
    .delete()
    .eq("id", params.id)
    .eq("user_id", user.id);
  if (error) {
    return NextResponse.json({ error: "Could not remove that key." }, { status: 500 });
  }
  await logDashboard(user, request, {
    category: "api_key",
    action: "api_key.revoked",
    summary: "Revoked a Lettertrace API key",
    targetType: "api_key",
    targetId: params.id,
  });
  return NextResponse.json({ ok: true });
}
