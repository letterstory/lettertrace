import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getConfiguredProviders, getRouterKeysPublic, setActiveProject } from "@/lib/data";
import { executeRun } from "@/lib/engine";
import { humanError } from "@/lib/llm";
import {
  resolveRunKey,
  resolveRunKeyFor,
  consumeTrialRun,
  recordTrialUsage,
  recordTrialSpend,
  runBudgetMicros,
  pickDefaultProvider,
  engineKeyMessage,
  trialCoveredProviders,
  trialRunLimit,
  getTrialUsage,
  type ResolvedKey,
} from "@/lib/trial";
import { trialSpendLimitMicros } from "@/lib/pricing";
import { defaultModelFor } from "@/lib/models";
import { coveredProviders } from "@/lib/routers";
import { normalizeCompetitorList } from "@/lib/competitors";
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

  // Creating an organization is free and unlimited: it is configuration, not
  // consumption. A second org used to be refused without the user's own key,
  // on the reasoning that its first monitor would spend a free run — but the
  // free-run allowance is counted per ACCOUNT by consume_trial_run, not per
  // org, so extra orgs can't spend more than the allowance either way. All the
  // gate actually did was block someone from setting up the brands they wanted
  // to monitor before deciding to bring a key.
  const providers = await getConfiguredProviders(supabase, user.id);
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

  // Start the project on an engine this user can actually run. Runs no longer
  // substitute another provider's key, so defaulting purely on the operator's
  // trial config would hand a BYOK user a project whose first monitor can't
  // execute — with a perfectly good key sitting in Settings. Their own key wins
  // over the trial; the env default applies only when they have none.
  //
  // A router key counts here exactly as a direct key does. It used to not, so a
  // user whose only credential was a gateway got a project pinned to the env
  // default and a first run refused for a key they had deliberately replaced.
  // New projects are created grounded (use_web_search defaults on in the
  // database), so coverage is asked for the grounded case.
  const routerKeys = await getRouterKeysPublic(supabase, user.id);
  const runnable = coveredProviders({
    direct: providers,
    routers: routerKeys.map((k) => ({ router: k.router, searchVerified: k.search_verified ?? [] })),
    webSearch: true,
  });
  const envDefault = pickDefaultProvider();
  const provider =
    runnable.length === 0 || runnable.includes(envDefault) ? envDefault : runnable[0];
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
      // "Cadence from the onset": a new project monitors on a schedule from
      // day one (trial-funded until the allowance runs out, then unblocked by
      // the user's own key) instead of being a one-shot demo whose schedule
      // hides in Settings. The Runs page control turns it off in one click.
      schedule: "daily",
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
    metadata: { topics: topics.length, competitors: competitors.length, brand_name },
  });

  // Persist competitors before the first run: executeRun reads them to detect
  // rival mentions, so seeding them after the run would leave that run's
  // answers scored against the brand alone and no share of voice to show.
  if (competitors.length > 0) {
    const { error: compErr } = await supabase.from("competitors").insert(
      competitors.map((c) => ({
        project_id: project.id,
        name: c.name,
        aliases: c.aliases,
        domain: c.domain,
      })),
    );
    // Non-fatal: the project and its topics are already real, and the user can
    // add competitors from the Competitors page. Losing them shouldn't cost
    // them the whole onboarding they just completed.
    if (compErr) {
      console.error("[onboarding] competitor insert failed:", compErr.message);
    }
  }

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

  // First measurement is a SWEEP: one run per engine the account can fund —
  // the user's own coverage, plus the trial's while the allowance lasts — in
  // parallel, so the wall clock stays roughly one run. Probing every engine on
  // the first run maximizes the chance of finding a mention at all, which is
  // the moment the product proves itself.
  const usage = await getTrialUsage(supabase, user.id);
  const trialActive =
    usage.runs < trialRunLimit() && usage.spendMicros < trialSpendLimitMicros();
  const sweep = Array.from(
    new Set([...runnable, ...(trialActive ? trialCoveredProviders(true) : [])]),
  );
  // The project's own engine leads: its run is the one the response points at.
  sweep.sort((a, b) =>
    a === project.default_provider ? -1 : b === project.default_provider ? 1 : 0,
  );

  const keys: ResolvedKey[] = [];
  for (const p of sweep) {
    const k = await resolveRunKeyFor(supabase, user.id, p, defaultModelFor(p), {
      webSearch: true,
    });
    if ((k.source === "own" || k.source === "trial") && k.apiKey) keys.push(k);
  }

  if (keys.length === 0) {
    const key = await resolveRunKey(supabase, user.id, project);
    return NextResponse.json({
      projectId: project.id,
      ran: false,
      // 'mismatch' = they have a key, just not for the engine this project was
      // created with, so the message points at the engine rather than at signup.
      needsKey: key.source === "own" || key.source === "trial" ? "none" : key.source,
      keyMessage: engineKeyMessage(key),
    });
  }

  // Atomically consume a free run per trial-funded engine BEFORE executing
  // (see /api/runs). Sequential on purpose: the sweep stops being granted runs
  // at exactly the engine where the allowance ran out.
  const funded: ResolvedKey[] = [];
  for (const k of keys) {
    if (k.source === "trial" && !(await consumeTrialRun(supabase))) continue;
    funded.push(k);
  }
  if (funded.length === 0) {
    return NextResponse.json({
      projectId: project.id,
      ran: false,
      needsKey: "exhausted",
    });
  }

  // Trial-funded runs share the remaining spend budget rather than each
  // claiming all of it — the recorded overshoot past the cap is otherwise
  // multiplied by however many runs launched from the same snapshot.
  const trialRuns = funded.filter((k) => k.source === "trial").length;

  const settled = await Promise.allSettled(
    funded.map(async (k) => {
      const budget = runBudgetMicros(k);
      const result = await executeRun({
        supabase,
        project,
        provider: k.provider,
        model: k.model,
        apiKey: k.apiKey!,
        route: k.route,
        budgetMicros: budget === null ? null : Math.floor(budget / Math.max(trialRuns, 1)),
        context: {
          channel: "dashboard",
          actorType: "user",
          actorId: user.id,
          actorLabel: user.email ?? "You",
        },
      });
      if (k.source === "trial") {
        await recordTrialUsage(supabase, result.tokensUsed);
        await recordTrialSpend(supabase, result.spendMicros);
      }
      return { provider: k.provider, runId: result.runId, status: result.status };
    }),
  );

  const runs = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));

  if (runs.length === 0) {
    const firstFailure = settled.find(
      (s): s is PromiseRejectedResult => s.status === "rejected",
    );
    return NextResponse.json(
      { projectId: project.id, ran: false, error: humanError(firstFailure?.reason) },
      { status: 200 },
    );
  }

  return NextResponse.json({
    projectId: project.id,
    ran: true,
    // The default engine's run (the sweep is sorted so it launched first).
    runId: runs[0].runId,
    status: runs[0].status,
    runs,
  });
}
