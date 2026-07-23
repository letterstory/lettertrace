import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { humanError } from "@/lib/llm";

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

  try {
    const { error } = await supabase
      .from("provider_keys")
      .delete()
      .eq("id", params.id)
      .eq("user_id", user.id);

    if (error) {
      return NextResponse.json({ error: humanError(error) }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
