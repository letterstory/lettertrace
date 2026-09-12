import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setActiveProject } from "@/lib/data";
import {
  firstSweep,
  OnboardError,
  parseOnboardingCadence,
  persistOnboarding,
  pickProjectEngine,
  sessionTrialMeter,
  type TopicInput,
} from "@/lib/onboard";
import { normalizeCompetitorList } from "@/lib/competitors";
import { logDashboard } from "@/lib/activity";
import type { Project } from "@/lib/types";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

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
//
// The work itself — which engine to start on, what to save, the first sweep
// and how it spends the free trial — lives in lib/onboard, shared with the
// API's one-shot POST /api/v1/onboard so the two can't drift.
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

  // Creating an organization is free and unlimited: it is configuration, not
  // consumption. A second org used to be refused without the user's own key,
  // on the reasoning that its first monitor would spend a free run — but the
  // free-run allowance is counted per ACCOUNT by consume_trial_run, not per
  // org, so extra orgs can't spend more than the allowance either way. All the
  // gate actually did was block someone from setting up the brands they wanted
  // to monitor before deciding to bring a key.
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

  // Competitors are optional — a project with none is valid, it just can't
  // report share of voice yet. The brand and its aliases are excluded however
  // they arrived: a client can post this body without ever having asked for
  // suggestions, so the model-side filtering isn't sufficient on its own.
  const competitors = normalizeCompetitorList(body.competitors, {
    exclude: [brand_name, ...brand_aliases],
  });

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

  // Absent remains daily for backwards compatibility with the dashboard
  // wizard. The v1 one-shot flow uses the same parser with an "off" fallback.
  // This route's body uses camelCase `intervalDays`, so the field name is
  // passed through rather than string-rewritten out of the parser's message.
  let cadence: ReturnType<typeof parseOnboardingCadence>;
  try {
    cadence = parseOnboardingCadence(body.schedule, body.intervalDays, "daily", "intervalDays");
  } catch (error) {
    if (error instanceof OnboardError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  // Start the project on an engine this user can actually run — the user's
  // own key wins over the trial; the env default applies only when they have
  // none. See pickProjectEngine.
  const engine = await pickProjectEngine(supabase, user.id);
  const { provider, model } = engine;

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
      // "Cadence from the onset": the user picks the schedule on the
      // onboarding CTA itself (validated above) instead of every project
      // silently starting on 'daily'. The Runs page control changes it any
      // time after.
      schedule: cadence.schedule,
      schedule_interval_days: cadence.scheduleIntervalDays,
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
    summary: `Set up "${brand_name}" with ${topics.length} topic${topics.length === 1 ? "" : "s"} and ${competitors.length} competitor${competitors.length === 1 ? "" : "s"}`,
    projectId: project.id,
    targetType: "project",
    targetId: project.id,
    metadata: {
      topics: topics.length,
      competitors: competitors.length,
      brand_name,
      schedule: cadence.schedule,
      interval_days: cadence.scheduleIntervalDays,
    },
  });

  // Competitors first, then topics + prompts: executeRun reads competitors to
  // detect rival mentions, so they must exist before the first run.
  await persistOnboarding(supabase, project, { topics, competitors });

  // First measurement is a sweep across every engine the account can fund:
  // the user's own coverage plus the trial's while the allowance lasts. Each
  // trial-funded engine atomically consumes one free run before it starts —
  // the same deal as the Run button, so a 3-engine sweep costs 3 of the 15.
  const outcome = await firstSweep({
    supabase,
    userId: user.id,
    project,
    runnable: engine.runnable,
    meter: sessionTrialMeter(supabase),
    context: {
      channel: "dashboard",
      actorType: "user",
      actorId: user.id,
      actorLabel: user.email ?? "You",
    },
  });

  if (!outcome.ran) {
    if ("error" in outcome) {
      return NextResponse.json(
        { projectId: project.id, ran: false, error: outcome.error },
        { status: 200 },
      );
    }
    return NextResponse.json({
      projectId: project.id,
      ran: false,
      // 'mismatch' = they have a key, just not for the engine this project was
      // created with, so the message points at the engine rather than at signup.
      needsKey: outcome.needsKey,
      keyMessage: outcome.keyMessage,
    });
  }

  return NextResponse.json({
    projectId: project.id,
    ran: true,
    // The default engine's run (the sweep is sorted so it launched first).
    runId: outcome.runs[0].runId,
    status: outcome.runs[0].status,
    runs: outcome.runs,
  });
}
