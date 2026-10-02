import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getProject } from "@/lib/data";
import { executeRun } from "@/lib/engine";
import { humanError } from "@/lib/llm";
import { article } from "@/lib/utils";
import { PROVIDERS, isProvider, resolveEngine } from "@/lib/models";
import { sendSingleReportAttempt } from "@/lib/report-email-delivery";
import {
  finalizeGroupIfComplete,
  loadGroup,
  recordGroupSkip,
  touchGroup,
} from "@/lib/report-groups";
import {
  resolveRunKey,
  resolveRunKeyFor,
  consumeTrialRunFor,
  recordTrialUsageFor,
  recordTrialSpendFor,
  runBudgetMicros,
  engineKeyMessage,
} from "@/lib/trial";

export const maxDuration = 800;
export const dynamic = "force-dynamic";

// POST /api/runs, execute a monitoring run now for the signed-in user's project.
// Optional body { provider } runs this one run on another engine (that
// provider's default model) without touching the project — the loop behind
// "Run on all engines". No body preserves the original behavior exactly.
export async function POST(request: Request) {
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

  let overrideProvider: string | null = null;
  let groupId: string | null = null;
  try {
    const body = (await request.json()) as { provider?: unknown; groupId?: unknown } | null;
    if (typeof body?.provider === "string" && body.provider.length > 0) {
      overrideProvider = body.provider;
    }
    // Which batch this run belongs to, so N runs produce one email instead of
    // N. The browser supplies it because the browser is what drives the batch.
    if (typeof body?.groupId === "string" && body.groupId.length > 0) {
      groupId = body.groupId;
    }
  } catch {
    // No/invalid body: run the project default, as this endpoint always has.
  }

  if (overrideProvider !== null && !isProvider(overrideProvider)) {
    return NextResponse.json(
      { error: `Unknown provider "${overrideProvider}". Use one of: ${Object.keys(PROVIDERS).join(", ")}.` },
      { status: 400 },
    );
  }
  // Same validate-then-resolve order as the v1 trigger: an override naming an
  // engine the catalog doesn't offer must fail before a run row can exist.
  const engine = overrideProvider
    ? resolveEngine(overrideProvider, undefined)
    : resolveEngine(project.default_provider, project.default_model);
  if (!engine.ok) {
    return NextResponse.json({ error: engine.message }, { status: 400 });
  }
  const providerLabel = PROVIDERS[engine.provider].label;

  // A group id arrives from the browser, so nothing about it is trusted. The
  // database enforces the project match a second time (guard_run_report_group),
  // but a refusal here is a 400 the caller can read instead of a 23514 from
  // inside executeRun, after the run row already exists.
  if (groupId !== null) {
    const group = await loadGroup(supabase, groupId);
    if (!group || group.project_id !== project.id) {
      return NextResponse.json({ error: "That report batch doesn't belong to this organization." }, { status: 400 });
    }
    if (group.email_status !== "pending") {
      return NextResponse.json({ error: "That report batch has already been summarised." }, { status: 409 });
    }
    if (!group.requested_providers.includes(engine.provider)) {
      return NextResponse.json({ error: `${providerLabel} wasn't part of that report batch.` }, { status: 400 });
    }
  }

  // An override resolves like any run for that engine, trial included: the
  // trial funds multi-engine runs (each one atomically consumes a free run
  // below, so a 3-engine sweep costs 3 of the allowance — that's the deal the
  // raised cap exists to cover).
  // The OWNER's credential pays for the run, whoever fired it.
  //
  // That is what a shared organization means: a teammate invited into it can
  // measure the brand without also having to bring their own Anthropic key,
  // and the account that set the project up is the one that agreed to spend.
  // The scheduler has always billed project.user_id this way, so before teams
  // existed these two paths merely happened to agree — they resolve the same
  // person now for the owner, and no longer diverge for anyone else.
  //
  // Service-role because a teammate's own RLS can't read the owner's keys or
  // move the owner's trial meters, which is exactly the point.
  const billing = createServiceClient();
  const payer = project.user_id;

  /**
   * Account for an engine that will never produce a run, then close the batch
   * if it was the last one outstanding. Deliberately NOT an email of its own:
   * the caller is shown engineKeyMessage inline, and the batch's single email
   * repeats it once at the end.
   */
  const recordRefusal = async (reason: string) => {
    if (groupId === null) return;
    try {
      await recordGroupSkip(billing, groupId, engine.provider, reason);
      await finalizeGroupIfComplete(billing, groupId);
    } catch (cause) {
      console.error(`[report-groups] could not record ${engine.provider} refusal: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  const key = overrideProvider
    ? await resolveRunKeyFor(billing, payer, engine.provider, engine.model, {
        webSearch: project.use_web_search,
      })
    : await resolveRunKey(billing, payer, project);

  const owned = project.user_id === user.id;
  // Every "no usable key" message ends by telling the reader to add one in
  // Settings, which is the fix for the OWNER and misleading for a teammate:
  // keys are per-account, so a key they added would not pay for this project.
  // The owner's copy is left exactly as it was.
  const addKeyFix = owned
    ? `Add your own ${providerLabel} key in Settings to keep monitoring.`
    : `This organization's owner needs to add ${article(providerLabel)} ${providerLabel} key to keep monitoring.`;
  const notOwnerNote = " The keys for this organization belong to its owner, not to you.";
  // A reason stored on a batch is read later by the OWNER, in one email, so it
  // carries the fix rather than the clicker's point of view.
  const exhaustedReason = `All ${key.limit ?? 0} free runs are used up. Add ${article(providerLabel)} ${providerLabel} key in Settings to keep monitoring.`;

  // The selected engine has no key. Refusing beats running: the alternative is
  // storing another assistant's answers under this project's trend line.
  // 'unroutable' belongs here too: the user holds a credential that reaches this
  // engine, but not one that can measure it comparably. engineKeyMessage carries
  // the reason and the fix.
  //
  // None of these three refusals sends an email. Nothing ran, so there is no
  // report to mail; the caller is reading the reason in the response as they
  // click. Mailing here also put a Resend round trip in front of a reply that
  // used to be instant, and let a user with no key generate one message per
  // click. A DUE SCHEDULED run that cannot start is the opposite case — nobody
  // is watching that one — and still mails, from the cron route.
  if (key.source === "none" || key.source === "mismatch" || key.source === "unroutable") {
    await recordRefusal(engineKeyMessage(key));
    return NextResponse.json(
      {
        error: engineKeyMessage(key) + (owned ? "" : notOwnerNote),
        ...(key.source === "mismatch" ? { engineMismatch: true, available: key.available } : {}),
      },
      { status: 400 },
    );
  }
  if (key.source === "exhausted") {
    await recordRefusal(exhaustedReason);
    return NextResponse.json(
      {
        error: `${owned ? "You've" : "This organization has"} used all ${key.limit ?? 0} free runs. ${addKeyFix}`,
        trialExhausted: true,
      },
      { status: 402 },
    );
  }

  // Atomically consume a free run BEFORE executing, so concurrent requests
  // can't all slip past the gate while the counter lags. A consumed run
  // counts even if it later fails.
  // A comped account runs on the trial keys without spending its run allowance.
  if (key.source === "trial" && !key.comped && !(await consumeTrialRunFor(billing, payer))) {
    await recordRefusal(exhaustedReason);
    return NextResponse.json(
      {
        error: `${owned ? "You've" : "This organization has"} used all ${key.limit ?? 0} free runs. ${addKeyFix}`,
        trialExhausted: true,
      },
      { status: 402 },
    );
  }

  let completedRunId: string | undefined;
  try {
    const result = await executeRun({
      supabase,
      project,
      provider: key.provider,
      model: key.model,
      apiKey: key.apiKey!,
      route: key.route,
      keySource: key.source,
      budgetMicros: runBudgetMicros(key),
      reportGroupId: groupId,
      context: {
        channel: "dashboard",
        actorType: "user",
        actorId: user.id,
        actorLabel: user.email ?? "You",
      },
    });
    completedRunId = result.runId;

    // Bill the operator's shared key. Tokens for visibility, dollars for the
    // ceiling — the run may already have stopped itself on that ceiling, but it
    // still has to be recorded or the next run starts from a stale total.
    if (key.source === "trial") {
      await recordTrialUsageFor(billing, payer, result.tokensUsed);
      await recordTrialSpendFor(billing, payer, result.spendMicros);
    }

    // One email per batch, or one per run when there is no batch. A grouped run
    // only nudges its batch; the batch mails once its last engine is accounted
    // for, which may be this run or may be a later one.
    if (groupId !== null) {
      await touchGroup(billing, groupId);
      await finalizeGroupIfComplete(billing, groupId);
    } else {
      await sendSingleReportAttempt(billing, project, { provider: key.provider, model: key.model }, result.runId);
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
    if (groupId !== null) {
      // A run row that exists already accounts for this engine, whatever state
      // it settles in. A throw BEFORE the row was written leaves nothing behind
      // to account for it, so record the reason or the batch waits for an
      // engine that will never report.
      if (completedRunId === undefined) await recordRefusal(humanError(e));
      else {
        await touchGroup(billing, groupId);
        await finalizeGroupIfComplete(billing, groupId);
      }
    } else {
      await sendSingleReportAttempt(billing, project, engine, completedRunId);
    }
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
