import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { DashboardNav } from "@/components/dashboard/nav";
import { OrgSwitcher } from "@/components/dashboard/org-switcher";
import { SignOutButton } from "@/components/dashboard/signout";
import { WhyFree } from "@/components/dashboard/why-free";
import { TrialBanner } from "@/components/dashboard/trial-banner";
import { RunReadyBanner } from "@/components/dashboard/run-ready-banner";
import { ThemeToggle } from "@/components/theme";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { adminAlertEmail, fireAndForget } from "@/lib/notify";
import { alertNewSignup } from "@/lib/notify-signup";
import { getProject, getProjects, getConfiguredProviders } from "@/lib/data";
import { getUnseenRun } from "@/lib/results-seen";
import { trialEnabled, trialRunLimit, getTrialRunsUsed } from "@/lib/trial";
import { modelLabel } from "@/lib/models";
import { timeAgo } from "@/lib/utils";

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
  if (adminAlertEmail()) {
    const { data: alertState } = await supabase
      .from("profiles")
      .select("admin_alerted_at")
      .eq("id", user.id)
      .maybeSingle();
    if (alertState && (alertState as { admin_alerted_at: string | null }).admin_alerted_at === null) {
      fireAndForget(alertNewSignup(createServiceClient(), user));
    }
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

  return (
    <div className="min-h-screen bg-paper md:flex">
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

          <DashboardNav />

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
