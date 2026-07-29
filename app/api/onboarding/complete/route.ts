import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getConfiguredProviders, getProjects, setActiveProject } from "@/lib/data";
import { executeRun } from "@/lib/engine";
import { humanError } from "@/lib/llm";
import {
  resolveRunKey,
  consumeTrialRun,
  recordTrialUsage,
  pickDefaultProvider,
  engineKeyMessage,
} from "@/lib/trial";
import { defaultModelFor } from "@/lib/models";
import { logDashboard } from "@/lib/activity";
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
// Creates an organization (project) + topics + prompts, makes it the active
// one, then immediately runs the first monitor so the user lands on results.
// Also used to add additional organizations. Returns { projectId, ran, runId }.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  // The first organization is free; another one needs the user's own key.
  // Enforced here as well as in the UI: without it, a second org could be
  // created by posting straight to this route, and its first monitor would
  // quietly spend one of the account's free runs.
  const [existingProjects, providers] = await Promise.all([
    getProjects(supabase, user.id),
    getConfiguredProviders(supabase, user.id),
  ]);
  if (existingProjects.length > 0 && providers.length === 0) {
    return NextResponse.json(
      {
        error:
          "Add your own API key before monitoring another brand. Free credits cover your first organization.",
        needsKey: true,
      },
      { status: 403 },
    );
  }
  const name =
    typeof body.name === "string" && body.name.trim() ? body.name.trim() : brand_name;
  // First entry = primary domain; the rest are phantom sites for the brand.
  const brand_domains = toStringArray(body.brand_domains);
  const description =
    typeof body.description === "string" && body.description.trim()
      ? body.description.trim()
      : null;
  const brand_aliases = toStringArray(body.brand_aliases);

  // toStringArray already drops blank entries, so an unused question input is
  // simply ignored — but a topic with NO usable question, or no name, is a
  // mistake we refuse rather than quietly drop. Silently filtering these meant
  // a caller could send three topics, get 201, and find one saved.
  const topics: TopicInput[] = Array.isArray(body.topics)
    ? (body.topics as unknown[]).map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        return {
          name: typeof o.name === "string" ? o.name.trim() : "",
          prompts: toStringArray(o.prompts),
        };
      })
    : [];

  const incomplete = topics
    .map((t, i) => ({ i, t }))
    .filter(({ t }) => !t.name || t.prompts.length === 0);

  if (incomplete.length > 0) {
    const { i, t } = incomplete[0];
    return NextResponse.json(
      {
        error: !t.name
          ? `Topic ${i + 1} needs a name.`
          : `Topic "${t.name}" needs at least one question.`,
        incompleteTopics: incomplete.map(({ i }) => i),
      },
      { status: 400 },
    );
  }

  // Start the project on an engine this user can actually run. Runs no longer
  // substitute another provider's key, so defaulting purely on the operator's
  // trial config would hand a BYOK user a project whose first monitor can't
  // execute — with a perfectly good key sitting in Settings. Their own key wins
  // over the trial; the env default applies only when they have none.
  const envDefault = pickDefaultProvider();
  const provider =
    providers.length === 0 || providers.includes(envDefault) ? envDefault : providers[0];
  const model = defaultModelFor(provider);

  const { data: projRow, error: projErr } = await supabase
    .from("projects")
    .insert({
      user_id: user.id,
      name,
      brand_name,
      brand_aliases,
      brand_domains,
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

  // The freshly created organization becomes the one the dashboard shows.
  await setActiveProject(supabase, user.id, project.id);

  await logDashboard(user, request, {
    category: "onboarding",
    action: "onboarding.completed",
    summary: `Set up "${brand_name}" with ${topics.length} topic${topics.length === 1 ? "" : "s"}`,
    projectId: project.id,
    targetType: "project",
    targetId: project.id,
    metadata: { topics: topics.length, brand_name },
  });

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
      // 'mismatch' = they have a key, just not for the engine this project was
      // created with, so the message points at the engine rather than at signup.
      needsKey: key.source === "own" || key.source === "trial" ? "none" : key.source,
      keyMessage: engineKeyMessage(key),
    });
  }

  // Atomically consume a free run before executing (see /api/runs).
  if (key.source === "trial" && !(await consumeTrialRun(supabase))) {
    return NextResponse.json({
      projectId: project.id,
      ran: false,
      needsKey: "exhausted",
    });
  }

  try {
    const result = await executeRun({
      supabase,
      project,
      provider: key.provider,
      model: key.model,
      apiKey: key.apiKey,
      context: {
        channel: "dashboard",
        actorType: "user",
        actorId: user.id,
        actorLabel: user.email ?? "You",
      },
    });
    if (key.source === "trial") {
      await recordTrialUsage(supabase, result.tokensUsed);
    }
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
