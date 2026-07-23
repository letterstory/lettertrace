import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { humanError } from "@/lib/llm";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { is_active } = (body ?? {}) as { is_active?: unknown };
  if (typeof is_active !== "boolean") {
    return NextResponse.json({ error: "is_active must be a boolean." }, { status: 400 });
  }

  try {
    const { error } = await supabase
      .from("prompts")
      .update({ is_active })
      .eq("id", params.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { error } = await supabase.from("prompts").delete().eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
