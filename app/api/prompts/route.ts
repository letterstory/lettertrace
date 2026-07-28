import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";
import { humanError } from "@/lib/llm";
import { logDashboard } from "@/lib/activity";
import type { Topic } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
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

  const { topic_id, text } = (body ?? {}) as { topic_id?: unknown; text?: unknown };

  if (typeof topic_id !== "string" || !topic_id) {
    return NextResponse.json({ error: "A topic is required." }, { status: 400 });
  }
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "Prompt text is required." }, { status: 400 });
  }

  // Verify the topic belongs to the user's project.
  const { data: topicData } = await supabase
    .from("topics")
    .select("id, project_id")
    .eq("id", topic_id)
    .maybeSingle();

  const topic = topicData as Pick<Topic, "id" | "project_id"> | null;
  if (!topic || topic.project_id !== project.id) {
    return NextResponse.json({ error: "Topic not found." }, { status: 404 });
  }

  try {
    const { data, error } = await supabase
      .from("prompts")
      .insert({
        project_id: project.id,
        topic_id,
        text: text.trim(),
        source: "manual",
        is_active: true,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await logDashboard(user, request, {
      category: "prompt",
      action: "prompt.added",
      summary: `Added a prompt: "${text.trim().slice(0, 80)}"`,
      projectId: project.id,
      targetType: "prompt",
      targetId: (data as { id: string }).id,
    });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
