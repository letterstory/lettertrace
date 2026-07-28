import { NextResponse } from "next/server";
import { getProject } from "@/lib/data";
import { humanError } from "@/lib/llm";
import { createClient } from "@/lib/supabase/server";
import { logDashboard } from "@/lib/activity";

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

  const project = await getProject(supabase, user.id);
  if (!project) {
    return NextResponse.json({ error: "Create a project first" }, { status: 400 });
  }

  try {
    const { error } = await supabase
      .from("competitors")
      .delete()
      .eq("id", params.id)
      .eq("project_id", project.id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    await logDashboard(user, request, {
      category: "competitor",
      action: "competitor.removed",
      summary: "Removed a competitor",
      projectId: project.id,
      targetType: "competitor",
      targetId: params.id,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
