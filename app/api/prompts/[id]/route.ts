import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";
import { humanError } from "@/lib/llm";
import { logDashboard } from "@/lib/activity";

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

  const project = await getProject(supabase, user.id);
  if (!project) {
    return NextResponse.json({ error: "No project found." }, { status: 400 });
  }

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
    // Scoped to the active organization, matching the topic/competitor routes.
    const { error } = await supabase
      .from("prompts")
      .update({ is_active })
      .eq("id", params.id)
      .eq("project_id", project.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await logDashboard(user, request, {
      category: "prompt",
      action: is_active ? "prompt.activated" : "prompt.deactivated",
      summary: `${is_active ? "Activated" : "Deactivated"} a prompt`,
      projectId: project.id,
      targetType: "prompt",
      targetId: params.id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const project = await getProject(supabase, user.id);
  if (!project) {
    return NextResponse.json({ error: "No project found." }, { status: 400 });
  }

  try {
    const { error } = await supabase
      .from("prompts")
      .delete()
      .eq("id", params.id)
      .eq("project_id", project.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await logDashboard(user, request, {
      category: "prompt",
      action: "prompt.removed",
      summary: "Removed a prompt",
      projectId: project.id,
      targetType: "prompt",
      targetId: params.id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
