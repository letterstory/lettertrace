import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";
import { humanError } from "@/lib/llm";
import { logDashboard } from "@/lib/activity";

export const dynamic = "force-dynamic";

// Edit a topic's context after creation. The description steers question
// generation (generateVariations injects it), and until this existed it was
// settable only in the moment the topic was created — the one moment the user
// least knows what to write in it.
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
  const { description } = (body ?? {}) as { description?: unknown };
  if (description !== null && typeof description !== "string") {
    return NextResponse.json(
      { error: "description must be a string or null." },
      { status: 400 },
    );
  }
  const clean =
    typeof description === "string" && description.trim() ? description.trim() : null;

  try {
    const { data, error } = await supabase
      .from("topics")
      .update({ description: clean })
      .eq("id", params.id)
      .eq("project_id", project.id)
      .select()
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Topic not found." }, { status: 404 });

    await logDashboard(user, request, {
      category: "topic",
      action: "topic.updated",
      summary: clean ? "Updated a topic's context" : "Cleared a topic's context",
      projectId: project.id,
      targetType: "topic",
      targetId: params.id,
    });
    return NextResponse.json(data);
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
