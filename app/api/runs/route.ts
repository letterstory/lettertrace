import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";
import { executeRun } from "@/lib/engine";
import { humanError } from "@/lib/llm";
import { PROVIDERS } from "@/lib/models";
import {
  resolveRunKey,
  consumeTrialRun,
  recordTrialUsage,
  recordTrialSpend,
  runBudgetMicros,
  engineKeyMessage,
} from "@/lib/trial";

export const maxDuration = 800;
export const dynamic = "force-dynamic";

// POST /api/runs, execute a monitoring run now for the signed-in user's project.
export async function POST() {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await getProject(supabase, user.id);
  if (!project) {
    return NextResponse.json({ error: "Create a project first" }, { status: 400 });
  }

  const providerLabel = PROVIDERS[project.default_provider].label;
  const key = await resolveRunKey(supabase, user.id, project);

  // The selected engine has no key. Refusing beats running: the alternative is
  // storing another assistant's answers under this project's trend line.
  // 'unroutable' belongs here too: the user holds a credential that reaches this
  // engine, but not one that can measure it comparably. engineKeyMessage carries
  // the reason and the fix.
  // 'ungrounded' joins them for the same reason, one layer further down: the
  // engine itself can't search, so no credential would make this run
  // comparable with the ones already on the trend line.
  if (
    key.source === "none" ||
    key.source === "mismatch" ||
    key.source === "unroutable" ||
    key.source === "ungrounded"
  ) {
    return NextResponse.json(
      {
        error: engineKeyMessage(key),
        ...(key.source === "mismatch" ? { engineMismatch: true, available: key.available } : {}),
      },
      { status: 400 },
    );
  }
  if (key.source === "exhausted") {
    return NextResponse.json(
      {
        error: `You've used all ${key.limit ?? 0} free runs. Add your own ${providerLabel} key in Settings to keep monitoring.`,
        trialExhausted: true,
      },
      { status: 402 },
    );
  }

  // Atomically consume a free run BEFORE executing, so concurrent requests
  // can't all slip past the gate while the counter lags. A consumed run
  // counts even if it later fails.
  if (key.source === "trial" && !(await consumeTrialRun(supabase))) {
    return NextResponse.json(
      {
        error: `You've used all ${key.limit ?? 0} free runs. Add your own ${providerLabel} key in Settings to keep monitoring.`,
        trialExhausted: true,
      },
      { status: 402 },
    );
  }

  try {
    const result = await executeRun({
      supabase,
      project,
      provider: key.provider,
      model: key.model,
      apiKey: key.apiKey!,
      route: key.route,
      budgetMicros: runBudgetMicros(key),
      context: {
        channel: "dashboard",
        actorType: "user",
        actorId: user.id,
        actorLabel: user.email ?? "You",
      },
    });

    // Bill the operator's shared key. Tokens for visibility, dollars for the
    // ceiling — the run may already have stopped itself on that ceiling, but it
    // still has to be recorded or the next run starts from a stale total.
    if (key.source === "trial") {
      await recordTrialUsage(supabase, result.tokensUsed);
      await recordTrialSpend(supabase, result.spendMicros);
    }

    // Echo the engine that actually answered. The caller asked for
    // key.requested; a trial forces the provider's cheap model, and the client
    // shouldn't have to re-derive which of the two it got.
    return NextResponse.json({
      ...result,
      keySource: key.source,
      provider: key.provider,
      model: key.model,
      // Which gateway carried it, if any — same reason the run row records it.
      route: key.route?.router ?? null,
    });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
