/**
 * Integration harness for automatic report emails (`report_groups`, the
 * `guard_run_report_group` trigger, and the send/finalize/sweep paths in
 * lib/report-groups.ts and lib/report-email-delivery.ts).
 *
 * The unit tests mock the database entirely, so they cannot prove the one
 * thing that actually gates this feature: that a run insert carrying a
 * report_group_id — sent by the BROWSER, under the caller's own RLS — is
 * accepted for the caller's own project and rejected for anyone else's. This
 * harness runs that insert as the signed-in user really would, against a real
 * Postgres, then exercises accounting, the single-send claim, email content
 * built from real seeded mentions, the toggle, the abandon sweep, and the
 * schedule-skip alert.
 *
 * No provider keys are used and no run actually executes: run and response
 * rows are inserted directly to stand in for runs that already happened,
 * which is enough to exercise every path except the LLM call itself. No
 * Resend key is used either: the Resend HTTP call is intercepted so email
 * CONTENT can be asserted without a live send — see the deferred live-send
 * pass this harness deliberately does not attempt.
 *
 *   npx tsx scripts/harness-report-emails.ts
 *
 * Requires in .env.local: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 * SUPABASE_SERVICE_ROLE_KEY. Needs no running dev server — every path here is
 * library code or a direct database call.
 *
 * NOT part of `npm test`: it needs a live (local) Postgres with this branch's
 * schema applied.
 *
 * Everything is namespaced to one throwaway user, deleted in a `finally`
 * including when an assertion fails. The user id is printed at the start so a
 * crashed run can be cleaned up by hand.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// lib/data wraps its readers in React's cache(), which only exists inside
// Next's runtime. Stub it as identity before anything downstream is imported —
// same treatment as scripts/harness-router-keys.ts.
const nodeRequire = createRequire(import.meta.url);
const react = nodeRequire("react") as { cache?: <T>(fn: T) => T };
if (typeof react.cache !== "function") react.cache = (fn) => fn;

async function loadLib() {
  return {
    ...(await import("../lib/report-groups")),
    ...(await import("../lib/report-email-delivery")),
    ...(await import("../lib/engine")),
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function loadEnvLocal(): void {
  const raw = readFileSync(resolve(repoRoot, ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (value && !process.env[m[1]]) process.env[m[1]] = value;
  }
}
loadEnvLocal();

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env.local`);
  return v;
}

const SUPABASE_URL = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const ANON_KEY = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE_ROLE = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// --- assertions -----------------------------------------------------------

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}
const results: Result[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  const mark = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${mark}  ${name}${detail && !ok ? `\n          ${detail}` : ""}`);
}
function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// --- Resend interception ---------------------------------------------------

interface CapturedSend {
  to: string[];
  subject: string;
  text: string;
  html: string;
}
const captured: CapturedSend[] = [];
let nextResendStatus = 200;

const realFetch = globalThis.fetch;
// Only intercept calls to Resend; everything else (Supabase's own fetch)
// passes straight through to the real implementation.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("api.resend.com")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    captured.push({ to: body.to, subject: body.subject, text: body.text, html: body.html ?? "" });
    return new Response(JSON.stringify({ id: "re_harness" }), { status: nextResendStatus });
  }
  return realFetch(input, init);
}) as typeof fetch;

async function main() {
  const {
    loadGroup,
    recordGroupSkip,
    touchGroup,
    outstandingProviders,
    finishGroup,
    finalizeGroupIfComplete,
    sweepAbandonedGroups,
    GROUP_ABANDON_MS,
    alertScheduleSkip,
    clearScheduleSkipAlert,
    RUN_TIME_BUDGET_MS,
    settleAbandonedRun,
  } = await loadLib();

  // Delivery must be configured for anything to reach the (intercepted) wire.
  process.env.RESEND_API_KEY = "re_harness_test";
  process.env.ADMIN_ALERT_FROM = "Lettertrace <reports@lettertrace.test>";
  process.env.NEXT_PUBLIC_SITE_URL = "https://lettertrace.example";

  const email = `lt-report-email-harness-${Date.now()}@example.com`;
  const password = crypto.randomBytes(18).toString("base64url");
  const { data: created, error: userErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userErr || !created.user) throw new Error(`Could not create a test user: ${userErr?.message}`);
  const userId = created.user.id;
  console.log(`test user ${email}  (${userId})`);

  const otherPassword = crypto.randomBytes(18).toString("base64url");
  const otherEmail = `lt-report-email-harness-other-${Date.now()}@example.com`;
  const { data: otherCreated, error: otherErr } = await admin.auth.admin.createUser({
    email: otherEmail,
    password: otherPassword,
    email_confirm: true,
  });
  if (otherErr || !otherCreated.user) throw new Error(`Could not create the second test user: ${otherErr?.message}`);
  const otherUserId = otherCreated.user.id;

  let projectId: string | null = null;
  let otherProjectId: string | null = null;
  const asUser: SupabaseClient = createClient(SUPABASE_URL, ANON_KEY);
  const asTeammate: SupabaseClient = createClient(SUPABASE_URL, ANON_KEY);

  try {
    // ------------------------------------------------------------------
    section("Schema");
    // ------------------------------------------------------------------
    {
      const { error } = await admin.from("report_groups").select("id").limit(1);
      check("report_groups table exists", !error, error?.message ?? "");

      const { error: colErr } = await admin.from("runs").select("report_group_id").limit(1);
      check("runs.report_group_id column exists", !colErr, colErr?.message ?? "");

      const { error: statusErr } = await admin
        .from("report_groups")
        .insert({ project_id: crypto.randomUUID(), requested_providers: ["anthropic", "openai"], email_status: "not-a-real-status" });
      check("an unknown email_status is rejected", Boolean(statusErr), "bad status was accepted");

      const { error: providerErr } = await admin
        .from("report_groups")
        .insert({ project_id: crypto.randomUUID(), requested_providers: ["anthropic", "not-a-real-provider"] });
      check("an unknown provider in requested_providers is rejected", Boolean(providerErr), "bad provider was accepted");

      const { error: soloErr } = await admin
        .from("report_groups")
        .insert({ project_id: crypto.randomUUID(), requested_providers: ["anthropic"] });
      check("a batch of one engine is rejected — this feature exists to combine at least two", Boolean(soloErr));
    }

    // ------------------------------------------------------------------
    section("Fixtures");
    // ------------------------------------------------------------------
    let signedIn = false;
    {
      const { data: proj, error: projErr } = await admin
        .from("projects")
        .insert({
          user_id: userId,
          name: "Report email harness",
          brand_name: "Acme",
          brand_domains: ["acme.test"],
          default_provider: "anthropic",
          default_model: "claude-haiku-4-5",
          use_web_search: true,
          replicates: 1,
        })
        .select("*")
        .single();
      if (projErr || !proj) throw new Error(`Could not create the project: ${projErr?.message}`);
      projectId = proj.id as string;
      // On for the rest of the run, EXCEPT the "Toggle and recipient" section
      // below, which flips it off and back on to prove the toggle itself.
      await admin.from("projects").update({ report_emails_enabled: true }).eq("id", projectId);

      const { data: otherProj } = await admin
        .from("projects")
        .insert({
          user_id: otherUserId,
          name: "Someone else's project",
          brand_name: "Globex",
          brand_domains: ["globex.test"],
          default_provider: "anthropic",
          default_model: "claude-haiku-4-5",
          use_web_search: true,
          replicates: 1,
        })
        .select("id")
        .single();
      otherProjectId = (otherProj as { id: string }).id;

      const { error: signInErr } = await asUser.auth.signInWithPassword({ email, password });
      signedIn = !signInErr;
      check("the test user can sign in (needed for the trigger/RLS section)", signedIn, signInErr?.message ?? "");
    }

    // ------------------------------------------------------------------
    section("guard_run_report_group — the trigger the browser-driven design depends on");
    // ------------------------------------------------------------------
    if (!signedIn || !projectId || !otherProjectId) {
      check("skipped: no signed-in session or fixtures", false, "cannot exercise RLS-gated inserts");
    } else {
      const { data: group, error: groupErr } = await admin
        .from("report_groups")
        .insert({ project_id: projectId, requested_providers: ["anthropic", "openai"] })
        .select("*")
        .single();
      if (groupErr || !group) throw new Error(`Could not create the batch: ${groupErr?.message}`);

      // The exact call /api/runs makes: an authenticated insert, own project,
      // own batch. This is the call the whole browser-driven redesign depends
      // on — if the trigger rejects this, every grouped run breaks in
      // production the moment a real user clicks the button.
      const { data: ownRun, error: ownRunErr } = await asUser
        .from("runs")
        .insert({
          project_id: projectId, status: "running", provider: "anthropic", model: "claude-haiku-4-5",
          report_group_id: group.id, prompt_count: 1, completed_count: 0,
        })
        .select("id")
        .single();
      check(
        "inserting a run with the CALLER'S OWN batch and project succeeds",
        !ownRunErr && Boolean(ownRun),
        ownRunErr?.message ?? "",
      );

      const { error: crossErr } = await asUser
        .from("runs")
        .insert({
          project_id: projectId, status: "running", provider: "openai", model: "gpt-4o-mini",
          report_group_id: crypto.randomUUID(), prompt_count: 1, completed_count: 0,
        });
      check("inserting a run with a NONEXISTENT batch id is rejected", Boolean(crossErr));

      const { data: otherGroup } = await admin
        .from("report_groups")
        .insert({ project_id: otherProjectId, requested_providers: ["anthropic", "openai"] })
        .select("id")
        .single();
      const { error: mismatchErr } = await asUser
        .from("runs")
        .insert({
          project_id: projectId, status: "running", provider: "openai", model: "gpt-4o-mini",
          report_group_id: (otherGroup as { id: string }).id, prompt_count: 1, completed_count: 0,
        });
      check(
        "inserting a run naming ANOTHER PROJECT'S batch id is rejected, even under the same project_id claim",
        Boolean(mismatchErr),
      );
      await admin.from("report_groups").delete().eq("id", (otherGroup as { id: string }).id);

      if (ownRun) {
        const { error: moveErr } = await asUser
          .from("runs")
          .update({ report_group_id: null })
          .eq("id", (ownRun as { id: string }).id);
        check("a run's batch link cannot be changed after the run is created", Boolean(moveErr));

        // The Reports page self-heals an abandoned run this way; the trigger
        // re-validates on every UPDATE, so this must still work when the
        // report_group_id itself is left untouched.
        const settled = await settleAbandonedRun(asUser, (ownRun as { id: string }).id, "Interrupted.");
        check("settling an abandoned GROUPED run, as the user, still succeeds", settled);
      }

      const { data: visible } = await asUser.from("report_groups").select("id").eq("id", group.id);
      check("the user can read their OWN batch", (visible ?? []).length === 1);

      if (otherProjectId) {
        const { data: otherVisible, error: otherGroupErr2 } = await admin
          .from("report_groups")
          .insert({ project_id: otherProjectId, requested_providers: ["anthropic", "openai"] })
          .select("id")
          .single();
        if (!otherGroupErr2 && otherVisible) {
          const { data: hidden } = await asUser.from("report_groups").select("id").eq("id", otherVisible.id);
          check("the user CANNOT read another project's batch", (hidden ?? []).length === 0);
          await admin.from("report_groups").delete().eq("id", otherVisible.id);
        }
      }

      await admin.from("runs").delete().eq("report_group_id", group.id);
      await admin.from("report_groups").delete().eq("id", group.id);
    }

    // ------------------------------------------------------------------
    section("report_groups has no write policy for a signed-in user — only the service role writes it");
    // ------------------------------------------------------------------
    // Every write in this feature (open a batch, record a skip, claim the
    // send, finalize) goes through the service client. If a signed-in user
    // could write this table directly, they could open a batch that skips
    // /api/report-groups' funding check, or set email_status='sent' on their
    // own row to fake a batch that was never actually summarised.
    if (signedIn && projectId) {
      const { error: insertErr } = await asUser
        .from("report_groups")
        .insert({ project_id: projectId, requested_providers: ["anthropic", "openai"] });
      check("a signed-in user cannot INSERT a batch directly", Boolean(insertErr));

      const { data: seeded } = await admin
        .from("report_groups")
        .insert({ project_id: projectId, requested_providers: ["anthropic", "openai"] })
        .select("id")
        .single();
      const seededId = (seeded as { id: string }).id;

      // With no UPDATE policy at all, Postgres RLS does not raise an error
      // here — the USING clause simply makes the row invisible to the update,
      // so it matches zero rows and returns success with an empty result.
      // "no error" is NOT the signal to check; "nothing changed" is.
      const { data: updateResult, error: updateErr } = await asUser
        .from("report_groups")
        .update({ email_status: "sent" })
        .eq("id", seededId)
        .select();
      check(
        "a signed-in user cannot UPDATE email_status on their OWN batch (e.g. to fake 'sent')",
        Boolean(updateErr) || (updateResult ?? []).length === 0,
      );

      const { data: unchanged } = await admin.from("report_groups").select("email_status").eq("id", seededId).single();
      check("...and the row is provably unchanged", (unchanged as { email_status: string }).email_status === "pending");

      const { error: deleteErr, count } = await asUser
        .from("report_groups")
        .delete({ count: "exact" })
        .eq("id", seededId);
      check("a signed-in user cannot DELETE their own batch", Boolean(deleteErr) || count === 0);

      await admin.from("report_groups").delete().eq("id", seededId);
    }

    // ------------------------------------------------------------------
    section("guard_projects — a TEAMMATE (not just a stranger) cannot flip the toggle directly");
    // ------------------------------------------------------------------
    // The PATCH route's 403 for a non-owner is an application-layer check.
    // projects_member_write gives any project member RLS access to UPDATE the
    // project row at all — membership is exactly what makes them able to
    // reach this table in the first place — so the ONLY thing stopping a
    // teammate from flipping report_emails_enabled by calling the table
    // directly, bypassing the route entirely, is the guard_projects trigger.
    // If someone ever "simplifies" that trigger, this is the test that would
    // catch it, where the route's own 403 never would.
    if (projectId) {
      const { error: memberErr } = await admin
        .from("project_members")
        .insert({ project_id: projectId, user_id: otherUserId });
      check("fixture: the second user can be added as a teammate", !memberErr, memberErr?.message ?? "");

      const { error: signInErr } = await asTeammate.auth.signInWithPassword({ email: otherEmail, password: otherPassword });
      check("fixture: the teammate can sign in", !signInErr, signInErr?.message ?? "");

      const { data: readable } = await asTeammate.from("projects").select("id").eq("id", projectId);
      check(
        "sanity: membership actually grants the teammate read access to the project (proves this is a real permission test, not a blocked-everything test)",
        (readable ?? []).length === 1,
      );

      const { data: toggled, error: toggleErr } = await asTeammate
        .from("projects")
        .update({ report_emails_enabled: false })
        .eq("id", projectId)
        .select();
      check(
        "the teammate cannot flip report_emails_enabled, even though they can write to the project row",
        Boolean(toggleErr) || (toggled ?? []).every((row: { report_emails_enabled?: boolean }) => row.report_emails_enabled !== false),
      );

      const { data: stillOn } = await admin.from("projects").select("report_emails_enabled").eq("id", projectId).single();
      check("...and the toggle is provably unchanged", (stillOn as { report_emails_enabled: boolean }).report_emails_enabled === true);

      // A harmless field on the same row, same teammate, same request shape —
      // confirms the trigger targets THIS column specifically, not every
      // update a teammate makes.
      const { error: nameErr } = await asTeammate
        .from("projects")
        .update({ name: "Renamed by teammate" })
        .eq("id", projectId);
      check("...while an ordinary field the teammate IS allowed to change still works", !nameErr, nameErr?.message ?? "");

      await admin.from("project_members").delete().eq("project_id", projectId).eq("user_id", otherUserId);
    }

    // ------------------------------------------------------------------
    section("Accounting — outstandingProviders and finalizeGroupIfComplete");
    // ------------------------------------------------------------------
    if (projectId) {
      const { data: group } = await admin
        .from("report_groups")
        .insert({ project_id: projectId, requested_providers: ["anthropic", "openai"] })
        .select("*")
        .single();
      const groupId = (group as { id: string }).id;

      const insertRun = (provider: string, status: string, completedCount: number) =>
        admin.from("runs").insert({
          project_id: projectId, status, provider, model: provider === "anthropic" ? "claude-haiku-4-5" : "gpt-4o-mini",
          report_group_id: groupId, prompt_count: 1, completed_count: completedCount,
        }).select("id").single();

      const { data: run1 } = await insertRun("anthropic", "completed", 1);

      const stillPending = await loadGroup(admin, groupId);
      const outstanding1 = outstandingProviders(stillPending!, [{ ...run1, provider: "anthropic" } as never]);
      check(
        "an engine with neither a run nor a skip is still outstanding",
        outstanding1.includes("openai") && !outstanding1.includes("anthropic"),
        JSON.stringify(outstanding1),
      );

      const notDone = await finalizeGroupIfComplete(admin, groupId);
      check("the batch does not finalize while an engine is outstanding", notDone === false);
      check("...and sent nothing", captured.length === 0, `captured ${captured.length}`);

      await recordGroupSkip(admin, groupId, "openai", "No OpenAI key saved. Add one in Settings.");
      const done = await finalizeGroupIfComplete(admin, groupId);
      check("the batch finalizes once the last engine is accounted for (by a skip)", done === true);
      check("...and sent exactly one email", captured.length === 1, `captured ${captured.length}`);

      const { data: finalRow } = await admin.from("report_groups").select("email_status").eq("id", groupId).single();
      check("email_status ends 'sent'", (finalRow as { email_status: string }).email_status === "sent");

      captured.length = 0;
      await admin.from("runs").delete().eq("report_group_id", groupId);
      await admin.from("report_groups").delete().eq("id", groupId);
    }

    // ------------------------------------------------------------------
    section("One send, once — concurrent finalizers");
    // ------------------------------------------------------------------
    if (projectId) {
      const { data: group } = await admin
        .from("report_groups")
        .insert({ project_id: projectId, requested_providers: ["anthropic", "openai"] })
        .select("*")
        .single();
      const g = group as Awaited<ReturnType<typeof loadGroup>>;
      await admin.from("runs").insert([
        { project_id: projectId, status: "completed", provider: "anthropic", model: "claude-haiku-4-5", report_group_id: g!.id, prompt_count: 1, completed_count: 1 },
        { project_id: projectId, status: "completed", provider: "openai", model: "gpt-4o-mini", report_group_id: g!.id, prompt_count: 1, completed_count: 1 },
      ]);

      await Promise.all([finishGroup(admin, g!), finishGroup(admin, g!)]);
      check("two concurrent finishGroup calls on the same batch send exactly one email", captured.length === 1, `captured ${captured.length}`);

      captured.length = 0;
      await admin.from("runs").delete().eq("report_group_id", g!.id);
      await admin.from("report_groups").delete().eq("id", g!.id);
    }

    // ------------------------------------------------------------------
    section("Email content, against real seeded mentions");
    // ------------------------------------------------------------------
    if (projectId) {
      const { data: group } = await admin
        .from("report_groups")
        .insert({ project_id: projectId, requested_providers: ["anthropic", "openai", "google", "perplexity"] })
        .select("*")
        .single();
      const g = group as Awaited<ReturnType<typeof loadGroup>>;

      const { data: run1 } = await admin.from("runs").insert({
        project_id: projectId, status: "completed", provider: "anthropic", model: "claude-haiku-4-5",
        report_group_id: g!.id, prompt_count: 4, completed_count: 4,
      }).select("id").single();
      const { data: resp1 } = await admin.from("responses").insert({
        run_id: (run1 as { id: string }).id, project_id: projectId, provider: "anthropic", model: "claude-haiku-4-5",
        response_text: "Acme is a leading vendor in this space.",
      }).select("id").single();
      await admin.from("mentions").insert({
        response_id: (resp1 as { id: string }).id, run_id: (run1 as { id: string }).id, project_id: projectId,
        entity_type: "brand", entity_name: "Acme", mentioned: true, mention_count: 1, first_position: 0.1, sentiment: "positive", recommended: true,
      });

      // A zero-mention completed run: the common case for a new customer, and
      // the case computeEntityStats synthesizes a zero brand row for rather
      // than making the brand silently vanish from the report.
      const { data: run2 } = await admin.from("runs").insert({
        project_id: projectId, status: "completed", provider: "google", model: "gemini-2.5-flash",
        report_group_id: g!.id, prompt_count: 4, completed_count: 4,
      }).select("id").single();

      // A run that was genuinely ATTEMPTED and FAILED, on a model that is NOT
      // the provider's catalog default ("sonar-pro"). Live-tested 2026-09-18:
      // finishGroup used to resolve the failure label from the project's
      // catalog default rather than the run's own model, so a real failed
      // trial run (forced onto claude-haiku-4-5) was reported to the owner as
      // "Claude Opus 4.8 didn't finish". This is that exact bug, pinned.
      await admin.from("runs").insert({
        project_id: projectId, status: "failed", provider: "perplexity", model: "sonar",
        report_group_id: g!.id, prompt_count: 4, completed_count: 0, error: "Invalid API key.",
      });

      // OpenAI never runs at all — recorded as a skip, the way a missing key
      // would be. Must be listed by name and never charted as 0%.
      await recordGroupSkip(admin, g!.id, "openai", "No OpenAI key saved. Add one in Settings.");
      await finalizeGroupIfComplete(admin, g!.id);

      const sent = captured.at(-1);
      check("exactly one email was sent for the four-engine batch", captured.length === 1, `captured ${captured.length}`);
      if (sent) {
        const { data: owner } = await admin.auth.admin.getUserById(userId);
        check("addressed to the OWNER's real email and no one else", sent.to.length === 1 && sent.to[0] === owner.user?.email, JSON.stringify(sent.to));
        check("names the skipped engine by label", sent.text.includes("OpenAI"), sent.text);
        // The provider label alone ("Perplexity (Sonar)") already contains
        // "Sonar", so the model label — rendered in its own parens — is what
        // actually distinguishes the real model from the catalog default.
        check(
          "names the FAILED engine's real model (Sonar), not the catalog default (Sonar Pro)",
          sent.text.includes("(Sonar)") && !sent.text.includes("Sonar Pro"),
          sent.text,
        );
        check("never fabricates a 0% for either engine that never completed", !/OpenAI[^\n]*0%/.test(sent.text) && !/Sonar[^\n]*0%/.test(sent.text), sent.text);
        check(
          "links back to a REAL seeded run id, not a placeholder",
          sent.html.includes(String((run1 as { id: string }).id)),
        );
        check("both a text and an HTML body are present", sent.text.length > 0 && sent.html.length > 0);
      }

      captured.length = 0;
      await admin.from("mentions").delete().eq("project_id", projectId);
      await admin.from("responses").delete().eq("project_id", projectId);
      await admin.from("runs").delete().eq("report_group_id", g!.id);
      await admin.from("report_groups").delete().eq("id", g!.id);
    }

    // ------------------------------------------------------------------
    section("Toggle and recipient");
    // ------------------------------------------------------------------
    if (projectId) {
      await admin.from("projects").update({ report_emails_enabled: false }).eq("id", projectId);
      const { data: group } = await admin
        .from("report_groups")
        .insert({ project_id: projectId, requested_providers: ["anthropic", "openai"] })
        .select("*")
        .single();
      const g = group as Awaited<ReturnType<typeof loadGroup>>;
      await recordGroupSkip(admin, g!.id, "anthropic", "reason a");
      await recordGroupSkip(admin, g!.id, "openai", "reason b");
      await finalizeGroupIfComplete(admin, g!.id);
      check("toggle OFF: nothing is captured", captured.length === 0, `captured ${captured.length}`);
      const { data: row } = await admin.from("report_groups").select("email_status").eq("id", g!.id).single();
      check("...and email_status records 'suppressed', not 'failed'", (row as { email_status: string }).email_status === "suppressed", (row as { email_status: string })?.email_status);
      await admin.from("report_groups").delete().eq("id", g!.id);
      await admin.from("projects").update({ report_emails_enabled: true }).eq("id", projectId);
    }

    // ------------------------------------------------------------------
    section("Sweeping abandoned batches");
    // ------------------------------------------------------------------
    if (projectId) {
      const stale = new Date(Date.now() - GROUP_ABANDON_MS - 60_000).toISOString();
      const { data: group } = await admin
        .from("report_groups")
        .insert({ project_id: projectId, requested_providers: ["anthropic", "openai"], last_activity_at: stale })
        .select("*")
        .single();
      const g = group as Awaited<ReturnType<typeof loadGroup>>;
      await admin.from("runs").insert({
        project_id: projectId, status: "completed", provider: "anthropic", model: "claude-haiku-4-5",
        report_group_id: g!.id, prompt_count: 1, completed_count: 1,
      });

      const closed = await sweepAbandonedGroups(admin);
      check("the sweep closes at least the one stale batch", closed >= 1, `closed=${closed}`);
      const { data: row } = await admin.from("report_groups").select("email_status, skipped").eq("id", g!.id).single();
      const skipped = (row as { skipped: Record<string, string> } | null)?.skipped ?? {};
      check("the never-started engine is named as never started", /page was closed/.test(skipped.openai ?? ""), JSON.stringify(skipped));
      check("...and the batch is closed (mailed) rather than left pending", (row as { email_status: string })?.email_status !== "pending");

      check(
        "GROUP_ABANDON_MS exceeds a single run's own budget — otherwise a run still working gets closed out from under it",
        GROUP_ABANDON_MS > RUN_TIME_BUDGET_MS,
      );

      // A fresh batch must be left alone.
      const { data: fresh } = await admin
        .from("report_groups")
        .insert({ project_id: projectId, requested_providers: ["anthropic", "openai"] })
        .select("id")
        .single();
      captured.length = 0;
      await sweepAbandonedGroups(admin);
      const { data: freshRow } = await admin.from("report_groups").select("email_status").eq("id", (fresh as { id: string }).id).single();
      check("a batch still being driven is left pending, not swept", (freshRow as { email_status: string }).email_status === "pending");

      captured.length = 0;
      await admin.from("runs").delete().eq("report_group_id", g!.id);
      await admin.from("report_groups").delete().in("id", [g!.id, (fresh as { id: string }).id]);
    }

    // ------------------------------------------------------------------
    section("Schedule-skip alert — says it once");
    // ------------------------------------------------------------------
    if (projectId) {
      await admin.from("projects").update({ schedule_skip_alerted_at: null }).eq("id", projectId);
      const { data: proj } = await admin.from("projects").select("*").eq("id", projectId).single();

      const first = await alertScheduleSkip(admin, proj as never, "no key");
      check("the first sweep to see a broken schedule alerts", first !== "already-alerted", String(first));
      check("...and sends exactly one email", captured.length === 1, `captured ${captured.length}`);

      captured.length = 0;
      const second = await alertScheduleSkip(admin, proj as never, "no key");
      const third = await alertScheduleSkip(admin, proj as never, "no key");
      check("a second and third sweep meeting the SAME broken project say nothing new", second === "already-alerted" && third === "already-alerted");
      check("...and send nothing", captured.length === 0, `captured ${captured.length}`);

      await clearScheduleSkipAlert(admin, proj as never);
      const fourth = await alertScheduleSkip(admin, proj as never, "no key");
      check("after a run gets through and clears the flag, the next breakage is reported again", fourth !== "already-alerted", String(fourth));

      captured.length = 0;
      await admin.from("projects").update({ schedule_skip_alerted_at: null }).eq("id", projectId);
    }

    // ------------------------------------------------------------------
    section("No retry on a failed send");
    // ------------------------------------------------------------------
    if (projectId) {
      const { data: group } = await admin
        .from("report_groups")
        .insert({ project_id: projectId, requested_providers: ["anthropic", "openai"] })
        .select("*")
        .single();
      const g = group as Awaited<ReturnType<typeof loadGroup>>;
      await recordGroupSkip(admin, g!.id, "anthropic", "reason a");
      await recordGroupSkip(admin, g!.id, "openai", "reason b");

      nextResendStatus = 422;
      await finalizeGroupIfComplete(admin, g!.id);
      nextResendStatus = 200;

      const { data: row } = await admin.from("report_groups").select("email_status").eq("id", g!.id).single();
      check("a Resend rejection is recorded as 'failed'", (row as { email_status: string }).email_status === "failed");

      captured.length = 0;
      await finishGroup(admin, g!);
      check("re-finalizing a failed batch does not retry the send", captured.length === 0, `captured ${captured.length}`);

      await admin.from("report_groups").delete().eq("id", g!.id);
    }
  } finally {
    globalThis.fetch = realFetch;
    if (projectId) {
      await admin.from("mentions").delete().eq("project_id", projectId);
      await admin.from("responses").delete().eq("project_id", projectId);
      await admin.from("runs").delete().eq("project_id", projectId);
      await admin.from("report_groups").delete().eq("project_id", projectId);
      await admin.from("projects").delete().eq("id", projectId);
    }
    if (otherProjectId) {
      await admin.from("report_groups").delete().eq("project_id", otherProjectId);
      await admin.from("projects").delete().eq("id", otherProjectId);
    }
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    await admin.auth.admin.deleteUser(otherUserId).catch(() => {});
    console.log(`\ncleaned up ${email} and its counterpart`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} passed` +
      (failed.length ? `, \x1b[31m${failed.length} failed\x1b[0m` : ""),
  );
  if (failed.length) {
    for (const f of failed) console.log(`  \x1b[31m✗\x1b[0m ${f.name}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\nharness aborted: ${(e as Error).message}`);
  process.exit(2);
});
