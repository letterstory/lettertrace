import { Users } from "lucide-react";
import { Button, EmptyState, SectionHeading } from "@/components/ui";
import { getConfiguredProviders, getProject } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import type { Competitor } from "@/lib/types";
import { PROVIDERS } from "@/lib/models";
import { CompetitorsClient } from "./competitors-client";

export const dynamic = "force-dynamic";

export default async function CompetitorsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const project = await getProject(supabase, user.id);

  if (!project) {
    return (
      <div className="space-y-8">
        <SectionHeading
          title="Competitors"
          description="Ingest the competitors you want to benchmark against. Lettertrace tracks how often each one shows up in AI answers and computes share of voice."
        />
        <EmptyState
          icon={<Users className="h-8 w-8" />}
          title="Create your brand project first"
          description="You need a project before you can track competitors. Set up your brand to get started."
          action={<Button href="/dashboard/settings">Go to settings</Button>}
        />
      </div>
    );
  }

  const { data } = await supabase
    .from("competitors")
    .select("*")
    .eq("project_id", project.id)
    .order("created_at", { ascending: true });

  const competitors = (data as Competitor[] | null) ?? [];

  // Suggestions run on the project's chosen engine, so the key that matters is
  // that provider's — same rule the Topics page uses.
  const configured = await getConfiguredProviders(supabase, user.id);
  const hasKey = configured.includes(project.default_provider);
  const providerLabel = PROVIDERS[project.default_provider].label;

  return (
    <div className="space-y-8">
      <SectionHeading
        title="Competitors"
        description="Ingest the competitors you want to benchmark against. Lettertrace tracks how often each one shows up in AI answers and computes share of voice."
      />
      <CompetitorsClient
        competitors={competitors}
        hasKey={hasKey}
        providerLabel={providerLabel}
      />
    </div>
  );
}
