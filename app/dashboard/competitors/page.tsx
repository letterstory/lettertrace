import { Users } from "lucide-react";
import { Button, EmptyState, SectionHeading } from "@/components/ui";
import { getProject } from "@/lib/data";
import { createClient } from "@/lib/supabase/server";
import type { Competitor } from "@/lib/types";
import { PROVIDERS } from "@/lib/models";
import { resolveKey } from "@/lib/trial";
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

  // Ask the same resolver /api/competitors/suggest uses. Checking only for a
  // direct key on the default provider hid the button from anyone paying
  // through a router (Concentrate, OpenRouter) or on the free trial, though the
  // route itself would have served them.
  const key = await resolveKey(supabase, user.id, project.default_provider, project.default_model);
  const hasKey = key.source !== "none" && key.source !== "exhausted";
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
