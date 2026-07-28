import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";
import { humanError } from "@/lib/llm";
import { logDashboard } from "@/lib/activity";

export const dynamic = "force-dynamic";

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
      .from("topics")
      .delete()
      .eq("id", params.id)
      .eq("project_id", project.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await logDashboard(user, request, {
      category: "topic",
      action: "topic.removed",
      summary: "Removed a topic and its prompts",
      projectId: project.id,
      targetType: "topic",
      targetId: params.id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
