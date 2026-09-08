import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import { hasScope } from "@/lib/api-auth";
import { adminGate, isAdminEmail, isAdminUserId } from "@/lib/admin";
import { projectSummary, toAliases, toDomains } from "@/lib/api-service";
import {
  mintApiKey,
  onboardFromUrl,
  OnboardError,
  resolveOnboardingAccount,
  serviceTrialMeter,
  type OnboardingAccount,
  type TopicInput,
} from "@/lib/onboard";
import { apiActor, logActivity, logApiRequest } from "@/lib/activity";
import { humanError } from "@/lib/llm";
import type { Schedule } from "@/lib/types";
import type { SupabaseClient } from "@supabase/supabase-js";

// A sweep in the foreground can run for minutes; background (the default)
// answers as soon as the run rows exist.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const SCHEDULES: Schedule[] = ["off", "daily", "weekly"];

// POST /api/v1/onboard — a URL in, a monitored organization out.
//
// Reads the site (Firecrawl when FIRECRAWL_API_KEY is set, a plain fetch
// otherwise), has the model suggest topics + prompts + competitors, creates the
// organization, saves everything, and launches the first sweep on every engine
// the account can fund: the owner's own keys first, the free trial while it
// lasts. Each trial-funded engine consumes ONE free run, exactly as the Run
// button does — so one onboarded URL costs as many of the fifteen as the sweep
// has engines, and hands over to the owner's key the moment they add one.
//
// Body: { url, brand_name?, name?, description?, brand_aliases?,
//         brand_domains?, topics?: [{name, prompts[]}], competitors?,
//         schedule? ("off" default), run? (true), background? (true),
//         email?, key?: boolean | { name }, seat?: boolean }
//
// `email` is the transfer: it onboards the URL into THAT account — adopted
// when it exists, created when it doesn't — funds the sweep from that
// account's trial, and mints an API key for it (returned once, in
// `api_key.key`). Operators only: the caller's account must be on the admin
// allowlist (ADMIN_USER_IDS / ADMIN_EMAILS). Without `email` the URL is
// onboarded into the caller's own account.
//
// A transfer also seats the CALLER on the new organization as a team member
// (`seat: false` declines). That seat is how a system onboarding on the
// client's behalf keeps driving the project with its own key — prompts,
// competitors, runs, reports — while every run it triggers is billed to the
// owner: their trial, then their key. Members can't delete the project,
// manage its team, or touch the owner's keys.
//
// 202 when runs were started in the background, 201 otherwise.
export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "projects:write", "v1");
  if (auth instanceof Response) return auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    return NextResponse.json({ error: "A url is required." }, { status: 400 });
  }

  const run = body.run !== false;
  if (run && !hasScope(auth, "runs:trigger")) {
    return NextResponse.json(
      { error: 'Starting the first sweep needs the "runs:trigger" scope. Send {"run": false} to only create the organization.' },
      { status: 403, headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="runs:trigger"' } },
    );
  }

  if (typeof body.schedule === "string" && !SCHEDULES.includes(body.schedule as Schedule)) {
    return NextResponse.json(
      { error: `Unknown schedule "${body.schedule}". Use one of: ${SCHEDULES.join(", ")}.` },
      { status: 400 },
    );
  }

  const topics: TopicInput[] | null = Array.isArray(body.topics)
    ? (body.topics as unknown[]).map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        return {
          name: typeof o.name === "string" ? o.name.trim() : "",
          prompts: toAliases(o.prompts),
        };
      })
    : null;
  if (topics) {
    const bad = topics.find((t) => !t.name || t.prompts.length === 0);
    if (bad) {
      return NextResponse.json(
        {
          error: !bad.name
            ? "Every topic needs a name."
            : `Topic "${bad.name}" needs at least one prompt.`,
        },
        { status: 400 },
      );
    }
  }

  // The transfer: onboard into someone else's account. Operators only — the
  // gate is the same allowlist that opens /admin, checked by user id when ids
  // are configured and by email otherwise (see lib/admin for why ids win).
  const email = typeof body.email === "string" ? body.email.trim() : "";
  let account: OnboardingAccount | null = null;
  if (email) {
    const operator = await callerIsOperator(auth.supabase, auth.userId);
    if (!operator) {
      await logApiRequest(auth, request, "v1", {
        category: "onboarding",
        action: "api.onboard",
        status: "failure",
        statusCode: 403,
        summary: "Onboarding into another account refused: caller is not an operator",
      });
      return NextResponse.json(
        { error: "Only an operator may onboard a URL into another account. Omit `email` to onboard into your own." },
        { status: 403 },
      );
    }
    try {
      account = await resolveOnboardingAccount(auth.supabase, email);
    } catch (e) {
      const status = e instanceof OnboardError ? 400 : 500;
      return NextResponse.json({ error: humanError(e) }, { status });
    }
  }

  const ownerId = account?.userId ?? auth.userId;

  try {
    const outcome = await onboardFromUrl({
      supabase: auth.supabase,
      userId: ownerId,
      meter: serviceTrialMeter(auth.supabase, ownerId),
      context: apiActor(auth, "v1"),
      input: {
        url,
        brandName: typeof body.brand_name === "string" ? body.brand_name : null,
        name: typeof body.name === "string" ? body.name : null,
        description: typeof body.description === "string" ? body.description : null,
        brandAliases: toAliases(body.brand_aliases),
        extraDomains: toDomains(body.brand_domains),
        topics,
        competitors: body.competitors,
        schedule: typeof body.schedule === "string" ? (body.schedule as Schedule) : "off",
        run,
        background: body.background !== false,
      },
    });

    // The operator's seat on the transferred organization, unless declined.
    let seated = false;
    if (account && ownerId !== auth.userId && body.seat !== false) {
      const { error: seatErr } = await auth.supabase
        .from("project_members")
        .upsert(
          { project_id: outcome.project.id, user_id: auth.userId, invited_by: auth.userId },
          { onConflict: "project_id,user_id", ignoreDuplicates: true },
        );
      if (seatErr) console.error("[onboard] operator seat failed:", seatErr.message);
      else seated = true;
    }

    // The key the new owner drives the organization with. Default on when
    // transferring; `key: false` skips it, `key: { name }` names it.
    let apiKey: { id: string; name: string; hint: string; key: string } | null = null;
    let apiKeyError: string | undefined;
    if (account && body.key !== false) {
      const keyName =
        body.key && typeof body.key === "object" && typeof (body.key as { name?: unknown }).name === "string"
          ? ((body.key as { name: string }).name)
          : `Onboarding (${outcome.site.host})`;
      const minted = await mintApiKey(auth.supabase, ownerId, keyName);
      if (minted.ok) apiKey = { id: minted.id, name: minted.name, hint: minted.hint, key: minted.key };
      else apiKeyError = minted.error;
    }

    const sweep = outcome.sweep;
    const runs = sweep?.ran ? sweep.runs : [];
    const statusCode = runs.some((r) => r.status === "running") ? 202 : 201;
    const summary =
      `Onboarded ${outcome.site.host} as "${outcome.project.name}"` +
      (account ? ` into ${account.email}${account.created ? " (new account)" : ""}` : "") +
      `: ${outcome.saved.topics} topic${outcome.saved.topics === 1 ? "" : "s"}, ` +
      `${outcome.saved.competitors} competitor${outcome.saved.competitors === 1 ? "" : "s"}, ` +
      (runs.length > 0
        ? `${runs.length} run${runs.length === 1 ? "" : "s"} started (${runs.filter((r) => r.keySource === "trial").length} on the free trial)`
        : "no run started");

    // The organization's owner sees the setup in their own feed; the caller
    // sees the request in theirs (the same event when they are one person).
    await logActivity({
      userId: ownerId,
      ...apiActor(auth, "v1"),
      category: "onboarding",
      action: "onboarding.completed",
      summary,
      projectId: outcome.project.id,
      targetType: "project",
      targetId: outcome.project.id,
      metadata: {
        host: outcome.site.host,
        reader: outcome.site.reader,
        scraped: outcome.site.scraped,
        topics: outcome.saved.topics,
        prompts: outcome.saved.prompts,
        competitors: outcome.saved.competitors,
        runs: runs.length,
        trialRuns: runs.filter((r) => r.keySource === "trial").length,
        ...(account ? { transferred_to: account.email, account_created: account.created } : {}),
      },
    });
    if (ownerId !== auth.userId) {
      await logApiRequest(auth, request, "v1", {
        category: "onboarding",
        action: "api.onboard",
        statusCode,
        summary,
        metadata: { host: outcome.site.host, owner: ownerId },
      });
    }

    return NextResponse.json(
      {
        project: projectSummary(outcome.project),
        ...(account
          ? {
              account: { user_id: account.userId, email: account.email, created: account.created },
              seated,
            }
          : {}),
        ...(apiKey ? { api_key: apiKey } : {}),
        ...(apiKeyError ? { api_key_error: apiKeyError } : {}),
        site: outcome.site,
        suggestion: outcome.suggestion,
        ...(outcome.suggestionSkipped ? { suggestion_skipped: outcome.suggestionSkipped } : {}),
        saved: outcome.saved,
        topics: outcome.topics,
        competitors: outcome.competitors,
        ran: sweep?.ran ?? false,
        runs,
        ...(sweep && !sweep.ran
          ? "error" in sweep
            ? { error: sweep.error }
            : { needsKey: sweep.needsKey, keyMessage: sweep.keyMessage }
          : {}),
        ...(outcome.sweepSkipped ? { sweep_skipped: outcome.sweepSkipped } : {}),
        trial: outcome.trial,
      },
      { status: statusCode },
    );
  } catch (e) {
    const status = e instanceof OnboardError ? 400 : 500;
    await logApiRequest(auth, request, "v1", {
      category: "onboarding",
      action: "api.onboard",
      status: "failure",
      statusCode: status,
      summary: `Onboarding ${url} failed: ${humanError(e)}`,
    });
    return NextResponse.json({ error: humanError(e) }, { status });
  }
}

/** The same allowlist that opens /admin, applied to an API caller. */
async function callerIsOperator(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const gate = adminGate();
  if (gate === "none") return false;
  if (gate === "user-id") return isAdminUserId(userId);
  const { data } = await supabase
    .from("profiles")
    .select("email")
    .eq("id", userId)
    .maybeSingle();
  return isAdminEmail((data as { email?: string | null } | null)?.email);
}
