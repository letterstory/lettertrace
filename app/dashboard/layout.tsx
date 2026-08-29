import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { DashboardNav, type NavReport } from "@/components/dashboard/nav";
import { OrgSwitcher } from "@/components/dashboard/org-switcher";
import { SignOutButton } from "@/components/dashboard/signout";
import { WhyFree } from "@/components/dashboard/why-free";
import { TrialBanner } from "@/components/dashboard/trial-banner";
import { LetterproveAttest } from "@/components/letterprove-attest";
import { isFirstSignIn } from "@/lib/letterprove";
import { FounderCallOffer } from "@/components/dashboard/founder-call";
import { founderCallUrl, shouldOfferFounderCall, withinSignupWindow } from "@/lib/founder-call";
import { RunReadyBanner } from "@/components/dashboard/run-ready-banner";
import { ThemeToggle } from "@/components/theme";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { adminAlertEmails, fireAndForget } from "@/lib/notify";
import { alertNewSignup } from "@/lib/notify-signup";
import { getProject, getProjects, getConfiguredProviders } from "@/lib/data";
import { getUnseenRun } from "@/lib/results-seen";
import { trialEnabled, trialRunLimit, getTrialRunsUsed } from "@/lib/trial";
import { modelLabel } from "@/lib/models";
import { timeAgo } from "@/lib/utils";
import type { Run } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [project, projects] = await Promise.all([
    getProject(supabase, user.id),
    getProjects(supabase, user.id),
  ]);

  // Two once-per-account flags, both on the same profile row, read together.
  //
  // Operator alert for a new account: this lives here rather than in the auth
  // callback because email confirmation is optional — with it off, a password
  // signup gets a session immediately and never visits /auth/callback, so a
  // hook there would only ever see OAuth users. Every signed-in user reaches
  // the dashboard, whatever route they took in.
  //
  // Founder-call offer: for new signups only and only once ever.
  //
  // Both guards still short-circuit before any query — no admin emails means
  // alerting is switched off, and an unset URL or an established account means
  // the offer does not apply — but when either one IS live the row is fetched
  // once for both flags instead of once each. This layout renders on every
  // dashboard page, so a second read of the same row is a second chance to
  // catch a slow one for no extra information. The alert claim itself is
  // guarded in the database, so a second tab cannot produce a second email.
  const callUrl = founderCallUrl();
  const wantsAlertCheck = adminAlertEmails().length > 0;
  const wantsOfferCheck = !!callUrl && withinSignupWindow(user.created_at);

  // Started before the provider-key read below and awaited after it: they are
  // independent questions about the same user, so they travel together.
  const flagsPromise =
    wantsAlertCheck || wantsOfferCheck
      ? supabase
          .from("profiles")
          .select("admin_alerted_at, founder_call_prompted_at")
          .eq("id", user.id)
          .maybeSingle()
      : null;

  // Recent completed runs for the sidebar's Overview sub-menu. Depends only on
  // the project resolved above, so it rides in the same batch as the reads
  // below rather than costing its own round trip on every dashboard render.
  const reportsPromise = project
    ? supabase
        .from("runs")
        .select("id, provider, model, created_at", { count: "exact" })
        .eq("project_id", project.id)
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .limit(6)
    : null;

  // Trial banner state: only when a trial is offered and the user is relying on
  // shared keys. Key resolution prefers the user's own key from EITHER
  // provider, so any own key at all means they're never on the trial.
  const [providers, flagsResult, reportsResult] = await Promise.all([
    getConfiguredProviders(supabase, user.id),
    flagsPromise,
    reportsPromise,
  ]);

  const flags = (flagsResult?.data ?? null) as {
    admin_alerted_at: string | null;
    founder_call_prompted_at: string | null;
  } | null;

  if (wantsAlertCheck && flags && flags.admin_alerted_at === null) {
    fireAndForget(alertNewSignup(createServiceClient(), user));
  }

  let offerFounderCall = false;
  if (wantsOfferCheck && callUrl) {
    offerFounderCall = shouldOfferFounderCall({
      url: callUrl,
      createdAt: user.created_at,
      // A failed read yields undefined, which is deliberately NOT treated as
      // "never asked" — see shouldOfferFounderCall.
      promptedAt: flags?.founder_call_prompted_at,
    });
  }

  let trial: { used: number; limit: number; exhausted: boolean } | null = null;
  if (project && trialEnabled() && providers.length === 0) {
    const used = await getTrialRunsUsed(supabase, user.id);
    const limit = trialRunLimit();
    trial = { used, limit, exhausted: used >= limit };
  }

  // A finished run the owner hasn't opened. Lives in the layout so it follows
  // them across the dashboard rather than only appearing on the page they
  // happened to be on when the run landed.
  const unseenRun = project ? await getUnseenRun(supabase, project) : null;

  // Recent reports for the sidebar's Overview sub-menu, fetched in the batch
  // above. Completed only — those are the ones with a results page behind them;
  // the runs page still shows running/failed rows. Formatted here so the nav
  // stays a pure client render.
  let navReports: NavReport[] = [];
  let reportCount = 0;
  if (reportsResult) {
    const { data: reportRows, count } = reportsResult;
    reportCount = count ?? 0;
    navReports = (
      (reportRows ?? []) as Pick<Run, "id" | "provider" | "model" | "created_at">[]
    ).map((r) => ({
      id: r.id,
      // Relative, not calendar dates — "the one from last week" is how the
      // list gets scanned; the model tells same-day reports apart.
      when: timeAgo(r.created_at),
      model: modelLabel(r.provider, r.model),
    }));
  }

  return (
    <div className="min-h-screen bg-paper md:flex">
      {/* Usage attestation. Mounted here rather than in the root layout because
          it reports on authenticated product usage, which only exists behind
          this boundary — and because `user` is already resolved above, so it
          costs no extra query. Only the domain of the address is ever sent. */}
      <LetterproveAttest email={user.email} firstSignIn={isFirstSignIn(user)} />

      {/* Mounted in the layout, not a page, so the 30s countdown survives
          navigating between dashboard routes. */}
      {offerFounderCall && callUrl && <FounderCallOffer url={callUrl} />}

      <aside className="flex flex-col border-b border-ink/10 bg-paper md:h-screen md:w-[260px] md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex flex-col gap-6 px-5 py-6 md:h-full">
          <div className="flex items-center justify-between gap-2">
            <Logo />
            <ThemeToggle className="hidden md:inline-flex" />
          </div>

          {project ? (
            <OrgSwitcher
              orgs={projects.map((p) => ({
                id: p.id,
                name: p.name,
                brandName: p.brand_name,
              }))}
              activeId={project.id}
            />
          ) : (
            <div className="rounded border border-ink/10 bg-paper-shade/50 px-4 py-3">
              <p className="text-sm text-ink-faint">No organization yet</p>
            </div>
          )}

          <DashboardNav reports={navReports} totalReports={reportCount} />

          <div className="mt-auto hidden flex-col gap-3 border-t border-ink/10 pt-4 md:flex">
            <WhyFree />
            <p className="truncate text-xs text-ink-faint" title={user.email ?? undefined}>
              {user.email}
            </p>
            <SignOutButton className="w-full justify-start" />
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-ink/10 pt-4 md:hidden">
            <div className="flex min-w-0 flex-col gap-1">
              <WhyFree />
              <p className="truncate text-xs text-ink-faint" title={user.email ?? undefined}>
                {user.email}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <SignOutButton />
            </div>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto px-6 py-8 md:px-10 md:h-screen">
        <div className="mx-auto max-w-6xl">
          {/* Above the trial banner: this one is timely and clears itself,
              where the BYOK nudge is standing context. */}
          {unseenRun && (
            <RunReadyBanner
              runId={unseenRun.id}
              status={unseenRun.status === "failed" ? "failed" : "completed"}
              answers={unseenRun.completed_count}
              plannedAnswers={unseenRun.prompt_count}
              modelName={modelLabel(unseenRun.provider, unseenRun.model)}
              finishedAgo={timeAgo(unseenRun.finished_at ?? unseenRun.created_at)}
              error={unseenRun.error}
            />
          )}
          {trial && (
            <TrialBanner used={trial.used} limit={trial.limit} exhausted={trial.exhausted} />
          )}
          {children}
        </div>
      </main>
    </div>
  );
}
