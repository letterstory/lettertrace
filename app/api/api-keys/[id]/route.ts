import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// DELETE /api/api-keys/:id — revoke a Lettertrace API key.
export async function DELETE(
  _request: Request,
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
  return NextResponse.json({ ok: true });
}
