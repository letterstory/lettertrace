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

  const { name, description, prompts, source } = (body ?? {}) as {
    name?: unknown;
    description?: unknown;
    prompts?: unknown;
    source?: unknown;
  };

  if (typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "A topic name is required." }, { status: 400 });
  }

  const cleanDescription =
    typeof description === "string" && description.trim() ? description.trim() : null;

  // Optional starter questions, so accepting a re-analysis suggestion is one
  // request (topic + its questions) instead of one per question. Their source
  // is caller-declared: the re-analysis flow inserts AI drafts, everything
  // else defaults to manual — same values the prompts table constrains.
  const initialPrompts = (Array.isArray(prompts) ? prompts : [])
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0)
    .slice(0, 20);
  const promptSource = source === "ai" ? ("ai" as const) : ("manual" as const);

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

    const topicId = (data as { id: string }).id;
    if (initialPrompts.length > 0) {
      const { error: promptErr } = await supabase.from("prompts").insert(
        initialPrompts.map((text) => ({
          project_id: project.id,
          topic_id: topicId,
          text,
          source: promptSource,
          is_active: true,
        })),
      );
      // Non-fatal: the topic is real either way, and the Generate button can
      // refill it. Refusing here would strand a created topic behind an error.
      if (promptErr) {
        console.error("[topics] initial prompt insert failed:", promptErr.message);
      }
    }

    await logDashboard(user, request, {
      category: "topic",
      action: "topic.created",
      summary: initialPrompts.length
        ? `Created topic "${name.trim()}" with ${initialPrompts.length} question${initialPrompts.length === 1 ? "" : "s"}`
        : `Created topic "${name.trim()}"`,
      projectId: project.id,
      targetType: "topic",
      targetId: topicId,
    });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
