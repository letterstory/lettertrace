import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";
import { resolveKey } from "@/lib/trial";
import { PROVIDERS } from "@/lib/models";
import type { Prompt, Topic } from "@/lib/types";
import { SectionHeading, EmptyState, Button } from "@/components/ui";
import { FolderOpen } from "lucide-react";
import { TopicsClient } from "./topics-client";

export const dynamic = "force-dynamic";

export default async function TopicsPage() {
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
          title="Topics"
          description="Track the subjects you care about. Lettertrace generates realistic questions people ask AI assistants about each topic, then monitors the answers."
        />
        <EmptyState
          icon={<FolderOpen className="h-6 w-6" />}
          title="Create your project first"
          description="Set up your brand and provider key in Settings, then come back to add the topics you want to monitor."
          action={<Button href="/dashboard/settings">Go to Settings</Button>}
        />
      </div>
    );
  }

  const [{ data: topicsData }, { data: promptsData }, key] = await Promise.all([
    supabase
      .from("topics")
      .select("*")
      .eq("project_id", project.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("prompts")
      .select("*")
      .eq("project_id", project.id)
      .order("created_at", { ascending: true }),
    resolveKey(supabase, user.id, project.default_provider, project.default_model),
  ]);

  const topics = (topicsData as Topic[] | null) ?? [];
  const prompts = (promptsData as Prompt[] | null) ?? [];
  // Same resolver the generate and reanalyze routes use, so a router key or the
  // free trial counts, not just a direct key on the default provider.
  const hasKey = key.source !== "none" && key.source !== "exhausted";
  const providerLabel = PROVIDERS[project.default_provider].label;

  return (
    <div className="space-y-8">
      <SectionHeading
        title="Topics"
        description="Track the subjects you care about. Lettertrace generates realistic questions people ask AI assistants about each topic, then monitors the answers."
      />
      <TopicsClient
        topics={topics}
        prompts={prompts}
        hasKey={hasKey}
        providerLabel={providerLabel}
      />
    </div>
  );
}
