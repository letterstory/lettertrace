import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";
import { executeRun } from "@/lib/engine";
import { humanError } from "@/lib/llm";
import { resolveRunKey, recordTrialUsage, pickDefaultProvider } from "@/lib/trial";
import { defaultModelFor } from "@/lib/models";
import type { Project } from "@/lib/types";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

interface TopicInput {
  name: string;
  prompts: string[];
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

// POST /api/onboarding/complete
// Creates the project + topics + prompts, then immediately runs the first
// monitor so the user lands on results. Returns { projectId, ran, runId }.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Never create a second project for a user.
  if (await getProject(supabase, user.id)) {
    return NextResponse.json({ error: "You already have a project." }, { status: 400 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const brand_name = typeof body.brand_name === "string" ? body.brand_name.trim() : "";
  if (!brand_name) {
    return NextResponse.json({ error: "Brand name is required." }, { status: 400 });
  }
  const name =
    typeof body.name === "string" && body.name.trim() ? body.name.trim() : brand_name;
  const brand_domain =
    typeof body.brand_domain === "string" && body.brand_domain.trim()
      ? body.brand_domain.trim()
      : null;
  const description =
    typeof body.description === "string" && body.description.trim()
      ? body.description.trim()
      : null;
  const brand_aliases = toStringArray(body.brand_aliases);

  const topics: TopicInput[] = Array.isArray(body.topics)
    ? (body.topics as unknown[])
        .map((t) => {
          const o = (t ?? {}) as Record<string, unknown>;
          return {
            name: typeof o.name === "string" ? o.name.trim() : "",
            prompts: toStringArray(o.prompts),
          };
        })
        .filter((t) => t.name.length > 0 && t.prompts.length > 0)
    : [];

  const provider = pickDefaultProvider();
  const model = defaultModelFor(provider);

  const { data: projRow, error: projErr } = await supabase
    .from("projects")
    .insert({
      user_id: user.id,
      name,
      brand_name,
      brand_aliases,
      brand_domain,
      description,
      default_provider: provider,
      default_model: model,
      schedule: "off",
    })
    .select("*")
    .single();

  if (projErr || !projRow) {
    return NextResponse.json(
      { error: projErr?.message ?? "Could not create your project." },
      { status: 500 },
    );
  }
  const project = projRow as Project;

  // Persist topics + their prompts.
  for (const topic of topics) {
    const { data: topicRow } = await supabase
      .from("topics")
      .insert({ project_id: project.id, name: topic.name, description: null })
      .select("id")
      .single();
    if (!topicRow) continue;
    const rows = topic.prompts.map((text) => ({
      project_id: project.id,
      topic_id: topicRow.id as string,
      text,
      source: "ai" as const,
      is_active: true,
    }));
    if (rows.length) await supabase.from("prompts").insert(rows);
  }

  // Immediately run the first search.
  const key = await resolveRunKey(supabase, user.id, project);
  if (!key.apiKey) {
    return NextResponse.json({
      projectId: project.id,
      ran: false,
      needsKey: key.source === "exhausted" ? "exhausted" : "none",
    });
  }

  try {
    const result = await executeRun({
      supabase,
      project,
      provider: key.provider,
      model: key.model,
      apiKey: key.apiKey,
    });
    if (key.source === "trial") await recordTrialUsage(supabase, result.tokensUsed);
    return NextResponse.json({
      projectId: project.id,
      ran: true,
      runId: result.runId,
      status: result.status,
    });
  } catch (e) {
    return NextResponse.json(
      { projectId: project.id, ran: false, error: humanError(e) },
      { status: 200 },
    );
  }
}
