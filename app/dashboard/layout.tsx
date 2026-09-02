import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { DashboardNav, type NavReport } from "@/components/dashboard/nav";
import { OrgSwitcher } from "@/components/dashboard/org-switcher";
import { SignOutButton } from "@/components/dashboard/signout";
import { WhyFree } from "@/components/dashboard/why-free";
import { ProductCta } from "@/components/dashboard/product-cta";
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

  // Operator alert for a new account. This lives here rather than in the auth
  // callback because email confirmation is optional: with it off, a password
  // signup gets a session immediately and never visits /auth/callback, so a
  // hook there would only ever see OAuth users. Every signed-in user reaches
  // the dashboard, whatever route they took in.
  //
  // Costs nothing when alerting is switched off — the check short-circuits
  // before any query — and one indexed read when it is on. The claim itself is
  // guarded in the database, so a second tab cannot produce a second email.
  if (adminAlertEmails().length > 0) {
    const { data: alertState } = await supabase
      .from("profiles")
      .select("admin_alerted_at")
      .eq("id", user.id)
      .maybeSingle();
    if (alertState && (alertState as { admin_alerted_at: string | null }).admin_alerted_at === null) {
      fireAndForget(alertNewSignup(createServiceClient(), user));
    }
  }

  // Founder-call offer, for new signups only and only once ever. Both guards
  // short-circuit before any query: unset URL means the feature does not exist
  // (self-hosted images ship without it), and the signup window means an
  // established account costs nothing to skip.
  const callUrl = founderCallUrl();
  let offerFounderCall = false;
  if (callUrl && withinSignupWindow(user.created_at)) {
    const { data: offerState } = await supabase
      .from("profiles")
      .select("founder_call_prompted_at")
      .eq("id", user.id)
      .maybeSingle();
    offerFounderCall = shouldOfferFounderCall({
      url: callUrl,
      createdAt: user.created_at,
      // A failed read yields undefined, which is deliberately NOT treated as
      // "never asked" — see shouldOfferFounderCall.
      promptedAt: (offerState as { founder_call_prompted_at: string | null } | null)
        ?.founder_call_prompted_at,
    });
  }

  // Trial banner state: only when a trial is offered and the user is relying on
  // shared keys. Key resolution prefers the user's own key from EITHER
  // provider, so any own key at all means they're never on the trial.
  const providers = await getConfiguredProviders(supabase, user.id);

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

  // Recent reports for the sidebar's Overview sub-menu. Completed only — those
  // are the ones with a results page behind them; the runs page still shows
  // running/failed rows. Formatted here so the nav stays a pure client render.
  let navReports: NavReport[] = [];
  let reportCount = 0;
  if (project) {
    const { data: reportRows, count } = await supabase
      .from("runs")
      .select("id, provider, model, created_at", { count: "exact" })
      .eq("project_id", project.id)
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(6);
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
        {/* Scrolls: six reports in the sub-menu plus the CTA push Sign out past
            the fold, and an h-screen column without it leaves them unreachable. */}
        <div className="flex flex-col gap-6 px-5 py-6 md:h-full md:overflow-y-auto">
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

          {/* The only mt-auto in this column, deliberately: flexbox splits free
              space equally between every auto margin, so leaving one on the
              account block below halved the slack and left this box floating
              mid-column instead of sitting on the footer. */}
          <ProductCta className="md:mt-auto" />

          <div className="hidden flex-col gap-3 border-t border-ink/10 pt-4 md:flex">
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
