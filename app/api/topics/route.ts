import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";
import { humanError } from "@/lib/llm";
import { logDashboard } from "@/lib/activity";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const project = await getProject(supabase, user.id);
  if (!project) {
    return NextResponse.json(
      { error: "Create your project in Settings first." },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { name, description } = (body ?? {}) as {
    name?: unknown;
    description?: unknown;
  };

  if (typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "A topic name is required." }, { status: 400 });
  }

  const cleanDescription =
    typeof description === "string" && description.trim() ? description.trim() : null;

  try {
    const { data, error } = await supabase
      .from("topics")
      .insert({
        project_id: project.id,
        name: name.trim(),
        description: cleanDescription,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await logDashboard(user, request, {
      category: "topic",
      action: "topic.created",
      summary: `Created topic "${name.trim()}"`,
      projectId: project.id,
      targetType: "topic",
      targetId: (data as { id: string }).id,
    });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
