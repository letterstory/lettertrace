import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";
import { generateVariations, humanError } from "@/lib/llm";
import { PROVIDERS } from "@/lib/models";
import { resolveRunKey, recordTrialUsage } from "@/lib/trial";
import { logDashboard } from "@/lib/activity";
import type { Topic } from "@/lib/types";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(
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

  const { data: topicData } = await supabase
    .from("topics")
    .select("*")
    .eq("id", params.id)
    .eq("project_id", project.id)
    .maybeSingle();

  const topic = topicData as Topic | null;
  if (!topic) return NextResponse.json({ error: "Topic not found." }, { status: 404 });

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // Empty/invalid body is fine, fall back to defaults.
    body = {};
  }

  const rawCount = (body as { count?: unknown })?.count;
  let count = typeof rawCount === "number" ? Math.floor(rawCount) : 8;
  if (!Number.isFinite(count)) count = 8;
  count = Math.max(1, Math.min(20, count));

  const providerLabel = PROVIDERS[project.default_provider].label;
  const key = await resolveRunKey(supabase, user.id, project);

  if (key.source === "none") {
    return NextResponse.json(
      { error: `Add a ${providerLabel} key in Settings first.` },
      { status: 400 },
    );
  }
  if (key.source === "exhausted") {
    return NextResponse.json(
      {
        error: `You've used all ${key.limit ?? 0} free runs. Add your own ${providerLabel} key in Settings to keep generating.`,
        trialExhausted: true,
      },
      { status: 402 },
    );
  }

  try {
    const { variations, tokens } = await generateVariations({
      provider: key.provider,
      model: key.model,
      apiKey: key.apiKey!,
      topicName: topic.name,
      topicDescription: topic.description,
      count,
    });

    if (key.source === "trial") {
      await recordTrialUsage(supabase, tokens);
    }

    if (!variations.length) {
      return NextResponse.json(
        { error: "The model returned no variations, try again." },
        { status: 400 },
      );
    }

    const rows = variations.map((text) => ({
      project_id: project.id,
      topic_id: topic.id,
      text,
      source: "ai" as const,
      is_active: true,
    }));

    const { data, error } = await supabase.from("prompts").insert(rows).select();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    await logDashboard(user, request, {
      category: "prompt",
      action: "prompt.generated",
      summary: `Generated ${rows.length} prompt${rows.length === 1 ? "" : "s"} with AI for topic "${topic.name}"`,
      projectId: project.id,
      targetType: "topic",
      targetId: topic.id,
      metadata: { count: rows.length, tokens, keySource: key.source },
    });

    return NextResponse.json({ prompts: data });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
