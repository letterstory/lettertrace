import { ScrollText } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProjects } from "@/lib/data";
import { queryActivityLogs, activityStats, type LogQuery } from "@/lib/logs";
import { StatCard, SectionHeading, EmptyState, Card, CardBody } from "@/components/ui";
import { LogsExplorer } from "./logs-explorer";

export const dynamic = "force-dynamic";

// Next passes searchParams as string | string[] | undefined per key.
type SP = Record<string, string | string[] | undefined>;

function str(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.length > 0 ? s : undefined;
}

export default async function LogsPage({ searchParams }: { searchParams: SP }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const filters: LogQuery = {
    q: str(searchParams.q),
    channel: str(searchParams.channel),
    category: str(searchParams.category),
    status: str(searchParams.status),
    actorType: str(searchParams.actor),
    projectId: str(searchParams.project),
    days: str(searchParams.days) ? Number(str(searchParams.days)) : undefined,
    page: str(searchParams.page) ? Number(str(searchParams.page)) : 1,
  };

  const [projects, stats, pageData] = await Promise.all([
    getProjects(supabase, user.id),
    activityStats(supabase, user.id),
    queryActivityLogs(supabase, user.id, filters),
  ]);

  const projectNames: Record<string, string> = {};
  for (const p of projects) projectNames[p.id] = p.name;

  const hasAnyLogs = stats.total > 0;

  return (
    <div className="space-y-8">
      <SectionHeading
        title="Logs"
        description="Every action, run, and API, MCP, or CLI call across your account, from users, agents, and the scheduler, in one searchable feed."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total events" value={stats.total.toLocaleString()} accent="terracotta" />
        <StatCard label="Last 24 hours" value={stats.last24h.toLocaleString()} accent="teal" />
        <StatCard
          label="Programmatic calls"
          value={stats.programmatic.toLocaleString()}
          hint="API + MCP + CLI"
          accent="butter"
        />
        <StatCard
          label="Failures (7d)"
          value={stats.failures7d.toLocaleString()}
          accent={stats.failures7d > 0 ? "terracotta" : "mint"}
        />
      </div>

      {!hasAnyLogs ? (
        <EmptyState
          icon={<ScrollText className="h-8 w-8" />}
          title="No activity yet"
          description="As soon as you run a monitor, change a setting, or an agent calls the API, it shows up here."
        />
      ) : (
        <Card>
          <CardBody className="p-0">
            <LogsExplorer
              rows={pageData.rows}
              total={pageData.total}
              page={pageData.page}
              pageSize={pageData.pageSize}
              pageCount={pageData.pageCount}
              projectNames={projectNames}
              filters={{
                q: filters.q ?? "",
                channel: filters.channel ?? "",
                category: filters.category ?? "",
                status: filters.status ?? "",
                actor: filters.actorType ?? "",
                project: filters.projectId ?? "",
                days: str(searchParams.days) ?? "",
              }}
            />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
