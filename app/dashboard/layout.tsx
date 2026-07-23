import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { DashboardNav } from "@/components/dashboard/nav";
import { SignOutButton } from "@/components/dashboard/signout";
import { TrialBanner } from "@/components/dashboard/trial-banner";
import { createClient } from "@/lib/supabase/server";
import { getProject, getConfiguredProviders } from "@/lib/data";
import { trialEnabled, trialTokenLimit, getTrialUsage } from "@/lib/trial";

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

  const project = await getProject(supabase, user.id);

  // Trial banner state: only when a trial is offered and the user is relying on
  // shared keys (no own key for their default provider).
  let trial: { used: number; limit: number; exhausted: boolean } | null = null;
  if (project && trialEnabled()) {
    const providers = await getConfiguredProviders(supabase, user.id);
    if (!providers.includes(project.default_provider)) {
      const used = await getTrialUsage(supabase, user.id);
      const limit = trialTokenLimit();
      trial = { used, limit, exhausted: used >= limit };
    }
  }

  return (
    <div className="min-h-screen bg-paper md:flex">
      <aside className="flex flex-col border-b border-ink/10 bg-paper md:h-screen md:w-[260px] md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex flex-col gap-6 px-5 py-6 md:h-full">
          <Logo />

          <div className="rounded-2xl border border-ink/10 bg-paper-shade/50 px-4 py-3">
            {project ? (
              <>
                <p className="truncate font-serif text-sm font-semibold text-ink">
                  {project.brand_name}
                </p>
                <p className="mt-0.5 truncate text-xs text-ink-faint">
                  {project.name}
                </p>
              </>
            ) : (
              <p className="text-sm text-ink-faint">No project yet</p>
            )}
          </div>

          <DashboardNav />

          <div className="mt-auto hidden flex-col gap-2 border-t border-ink/10 pt-4 md:flex">
            <p className="truncate text-xs text-ink-faint" title={user.email ?? undefined}>
              {user.email}
            </p>
            <SignOutButton />
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-ink/10 pt-4 md:hidden">
            <p className="truncate text-xs text-ink-faint" title={user.email ?? undefined}>
              {user.email}
            </p>
            <SignOutButton />
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto px-6 py-8 md:px-10 md:h-screen">
        <div className="mx-auto max-w-6xl">
          {trial && (
            <TrialBanner used={trial.used} limit={trial.limit} exhausted={trial.exhausted} />
          )}
          {children}
        </div>
      </main>
    </div>
  );
}
