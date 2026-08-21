import { ArrowRight, PlayCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProject, getConfiguredProviders, getRouterKeysPublic } from "@/lib/data";
import {
  resolveRunKey,
  engineKeyMessage,
  nextRunMessage,
  trialEnabled,
  trialCoveredProviders,
  trialRunLimit,
  getTrialUsage,
} from "@/lib/trial";
import { trialSpendLimitMicros } from "@/lib/pricing";
import { PROVIDERS, modelLabel } from "@/lib/models";
import { ROUTERS, coveredProviders } from "@/lib/routers";
import { timeAgo } from "@/lib/utils";
import { isAbandoned, settleAbandonedRun, INTERRUPTED_RUN_ERROR } from "@/lib/engine";
import type { Run, RunStatus } from "@/lib/types";
import {
  Button,
  Card,
  CardBody,
  SectionHeading,
  Badge,
  EmptyState,
} from "@/components/ui";
import { RunNow } from "./run-now";
import { RunAllEngines } from "./run-all-engines";
import { ScheduleControl } from "./schedule-control";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<RunStatus, "mint" | "teal" | "terracotta" | "neutral"> = {
  completed: "mint",
  running: "teal",
  failed: "terracotta",
  pending: "neutral",
};

export default async function RunsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const project = await getProject(supabase, user.id);
  if (!project) {
    return (
      <div className="space-y-8">
        <SectionHeading title="Runs" />
        <EmptyState
          title="No project yet"
          description="Create your project first, then you can run your first brand monitor."
          action={
            <Button href="/dashboard/settings">
              Create a project <ArrowRight className="h-4 w-4" />
            </Button>
          }
        />
      </div>
    );
  }

  // Ask the same resolver the run endpoint uses. Gating the button on a BYOK
  // key alone disabled it for trial users who had free runs left — the server
  // would have accepted the request the UI refused to send. It has to be the
  // RUN resolver specifically: the lenient one accepts any provider's key, so
  // the button read "ready" for an engine that has no key behind it.
  const key = await resolveRunKey(supabase, user.id, project);
  const canRun = key.source === "own" || key.source === "trial";

  // Every engine this account can fund a run on right now: engines the user's
  // own credentials cover, plus — while the trial allowance lasts — the ones
  // the operator's trial keys serve. This is the "run on all engines" list;
  // the run endpoint re-checks funding per run, so this is display truth, not
  // an authorization.
  const [configured, routerRows] = await Promise.all([
    getConfiguredProviders(supabase, user.id),
    getRouterKeysPublic(supabase, user.id),
  ]);
  const ownCovered = coveredProviders({
    direct: configured,
    routers: routerRows.map((k) => ({ router: k.router, searchVerified: k.search_verified ?? [] })),
    webSearch: project.use_web_search,
  });
  let available = ownCovered;
  if (trialEnabled()) {
    const usage = await getTrialUsage(supabase, user.id);
    const trialActive =
      usage.runs < trialRunLimit() && usage.spendMicros < trialSpendLimitMicros();
    if (trialActive) {
      available = Array.from(
        new Set([...ownCovered, ...trialCoveredProviders(project.use_web_search)]),
      );
    }
  }
  const engineList = available.map((p) => ({ provider: p, label: PROVIDERS[p].label }));

  const { count: activePrompts } = await supabase
    .from("prompts")
    .select("id", { count: "exact", head: true })
    .eq("project_id", project.id)
    .eq("is_active", true);

  const { data: runRows } = await supabase
    .from("runs")
    .select("*")
    .eq("project_id", project.id)
    .order("created_at", { ascending: false });
  const runs = (runRows ?? []) as Run[];

  // Settle provably-dead runs on the way past — the same self-heal GET
  // /v1/runs/:id/status does. A run row is written "running" up front and settled
  // by whatever executes it; if that process dies (a 60-answer run can outlive the
  // 300s function cap), nothing settles it until the daily cron. This list is the
  // first place an operator looks, so it shouldn't show a phantom "running" for a
  // run nothing is executing. The write is guarded + idempotent — safe against the
  // cron and concurrent viewers.
  await Promise.all(
    runs.map(async (run) => {
      if (!isAbandoned(run)) return;
      if (await settleAbandonedRun(supabase, run.id, INTERRUPTED_RUN_ERROR)) {
        run.status = "failed";
        run.error = INTERRUPTED_RUN_ERROR;
        run.finished_at = new Date().toISOString();
      }
    }),
  );

  return (
    <div className="space-y-8">
      <SectionHeading
        title="Runs"
        // Describes the NEXT run, and says so. The old copy claimed what
        // "each run" asks, sitting above a list of completed runs that named a
        // different model — see nextRunMessage.
        description={canRun ? nextRunMessage(key) : engineKeyMessage(key)}
        action={
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <RunNow
              canRun={canRun}
              keySource={key.source}
              activePrompts={activePrompts ?? 0}
              providerLabel={PROVIDERS[project.default_provider].label}
            />
            {/* Only when there's a second engine to offer — a one-engine
                "run on all engines" is the same button twice. */}
            {engineList.length >= 2 && (
              <RunAllEngines
                engines={engineList}
                disabled={(activePrompts ?? 0) === 0}
              />
            )}
          </div>
        }
      />

      {/* The schedule lives on the project settings form too, but this page is
          where people go to make runs happen — it's where "how do I run this
          daily?" gets asked. */}
      <ScheduleControl
        schedule={project.schedule}
        keySource={key.source}
        providerLabel={PROVIDERS[project.default_provider].label}
      />

      {runs.length === 0 ? (
        <EmptyState
          icon={<PlayCircle className="h-8 w-8" />}
          title="No runs yet"
          description="Run your first monitor to see where your brand shows up in AI answers."
        />
      ) : (
        <div className="space-y-3">
          {runs.map((run) => (
            <Card key={run.id}>
              <CardBody className="flex flex-wrap items-center justify-between gap-4 p-5">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={STATUS_TONE[run.status]}>{run.status}</Badge>
                    <span className="text-sm font-medium text-ink">
                      {modelLabel(run.provider, run.model)}
                    </span>
                    {/* The engine is what was measured; the router is only who
                        carried it. Shown because a series that steps at the run
                        where the credential changed is otherwise unexplained. */}
                    {run.route && ROUTERS[run.route] && (
                      <Badge tone="neutral">via {ROUTERS[run.route].label}</Badge>
                    )}
                    <span className="text-ink-faint">·</span>
                    <span className="text-sm text-ink-soft">
                      {run.completed_count} / {run.prompt_count} answers
                    </span>
                    <span className="text-ink-faint">·</span>
                    <span className="text-sm text-ink-faint">{timeAgo(run.created_at)}</span>
                  </div>
                  {run.error && (
                    <p className="text-xs text-terracotta">{run.error}</p>
                  )}
                </div>
                {run.status === "completed" && (
                  <Button href={`/dashboard/runs/${run.id}`} variant="secondary" size="sm">
                    View <ArrowRight className="h-4 w-4" />
                  </Button>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
