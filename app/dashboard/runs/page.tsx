import { ArrowRight, PlayCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";
import { resolveRunKey, engineKeyMessage, nextRunMessage } from "@/lib/trial";
import { PROVIDERS, modelLabel } from "@/lib/models";
import { timeAgo } from "@/lib/utils";
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

  return (
    <div className="space-y-8">
      <SectionHeading
        title="Runs"
        // Describes the NEXT run, and says so. The old copy claimed what
        // "each run" asks, sitting above a list of completed runs that named a
        // different model — see nextRunMessage.
        description={canRun ? nextRunMessage(key) : engineKeyMessage(key)}
        action={
          <RunNow
            canRun={canRun}
            keySource={key.source}
            activePrompts={activePrompts ?? 0}
            providerLabel={PROVIDERS[project.default_provider].label}
          />
        }
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
