import { KeyRound, Building2, Plug } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProject, getProviderKeysPublic } from "@/lib/data";
import { Card, CardBody, SectionHeading } from "@/components/ui";
import KeysManager from "./keys-manager";
import ApiKeysManager from "./api-keys-manager";
import ProjectForm from "./project-form";
import type { ApiKeyPublic } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [project, keys, apiKeysRes] = await Promise.all([
    getProject(supabase, user.id),
    getProviderKeysPublic(supabase, user.id),
    supabase
      .from("api_keys")
      .select("id, name, key_hint, last_used_at, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true }),
  ]);
  const apiKeys = (apiKeysRes.data as ApiKeyPublic[] | null) ?? [];

  return (
    <div className="space-y-8">
      <SectionHeading
        title="Settings"
        description="Connect your own model keys and describe the brand you want to monitor."
      />

      <Card>
        <CardBody className="space-y-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded-xl bg-mint/50 p-2 text-emerald-800">
              <KeyRound className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-lg font-semibold text-ink">Your model keys</h3>
              <p className="mt-1 text-sm text-ink-faint">
                Claude and ChatGPT are the assistants Lettertrace queries. Bring a
                key for each one you want to monitor with, they&apos;re encrypted at
                rest and never leave your server.
              </p>
            </div>
          </div>
          <KeysManager keys={keys} defaultProvider={project?.default_provider} />
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded-xl bg-butter/60 p-2 text-yellow-900">
              <Building2 className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-lg font-semibold text-ink">Organization</h3>
              <p className="mt-1 text-sm text-ink-faint">
                {project
                  ? `Settings for ${project.brand_name}, the organization selected in the sidebar. Tune how we recognize this brand across AI answers.`
                  : "Fill this in to get started, it powers prompt generation and mention detection."}
              </p>
            </div>
          </div>
          <ProjectForm project={project} />
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded-xl bg-teal/15 p-2 text-teal-900">
              <Plug className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-lg font-semibold text-ink">API &amp; MCP access</h3>
              <p className="mt-1 text-sm text-ink-faint">
                Create a key to read your share-of-voice data from scripts
                (REST, <code className="font-mono text-xs">/api/v1</code>) or
                connect Lettertrace to Claude and other MCP clients at{" "}
                <code className="font-mono text-xs">/api/mcp/mcp</code>, sent as{" "}
                <code className="font-mono text-xs">Authorization: Bearer</code>.
              </p>
            </div>
          </div>
          <ApiKeysManager keys={apiKeys} />
        </CardBody>
      </Card>
    </div>
  );
}
