import { KeyRound, Building2, Palette, Plug, Shuffle, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getProject, getProviderKeysPublic, getRouterKeysPublic } from "@/lib/data";
import { Card, CardBody, SectionHeading } from "@/components/ui";
import { ThemeSwitch } from "@/components/theme";
import KeysManager from "./keys-manager";
import RoutersManager from "./routers-manager";
import ApiKeysManager from "./api-keys-manager";
import ProjectForm from "./project-form";
import TeamManager from "./team-manager";
import type { ApiKeyPublic } from "@/lib/types";
import { trialEnabled } from "@/lib/trial";
import { loadTeam } from "@/lib/team";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [project, keys, routerKeys, apiKeysRes] = await Promise.all([
    getProject(supabase, user.id),
    getProviderKeysPublic(supabase, user.id),
    getRouterKeysPublic(supabase, user.id),
    supabase
      .from("api_keys")
      .select("id, name, key_hint, last_used_at, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true }),
  ]);
  const apiKeys = (apiKeysRes.data as ApiKeyPublic[] | null) ?? [];

  // Second pass, because it needs the project the first pass resolved. Service
  // role: the list has to name teammates by email, and a member's profile row
  // is not readable through the viewer's own RLS.
  const team = project ? await loadTeam(createServiceClient(), project) : null;
  const isOwner = project?.user_id === user.id;

  // The engine picker below must offer the engines THIS ORGANIZATION can
  // actually reach, which means the owner's credentials — a member picking
  // Gemini because they personally hold a Google key would set a default the
  // project can't run. Their own keys still render in the Keys card above:
  // those are theirs, and are used by the organizations they own.
  const payer = !project || isOwner ? null : createServiceClient();
  const [payerKeys, payerRouterKeys] =
    payer && project
      ? await Promise.all([
          getProviderKeysPublic(payer, project.user_id),
          getRouterKeysPublic(payer, project.user_id),
        ])
      : [keys, routerKeys];

  // The saved routers as the engine picker sees them: what each gateway reaches,
  // and what its search was confirmed for. Not reduced to a provider list here —
  // coverage depends on the web-search toggle inside the form, which is client
  // state, so the picker resolves it per keystroke from these credentials.
  const routerCoverage = payerRouterKeys.map((k) => ({
    router: k.router,
    searchVerified: k.search_verified ?? [],
  }));

  return (
    <div className="space-y-8">
      <SectionHeading
        title="Settings"
        description="Connect your own model keys and describe the brand you want to monitor."
      />

      <Card>
        <CardBody className="space-y-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded bg-mint-tint p-2 text-mint-ink">
              <KeyRound className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-lg font-semibold text-ink">Your model keys</h3>
              <p className="mt-1 text-sm text-ink-soft">
                Claude, ChatGPT, and Gemini are the assistants Lettertrace queries.
                Your Google key also powers Google AI Overviews. Bring a key for each
                one you want to monitor with. They&apos;re encrypted at rest.
              </p>
            </div>
          </div>
          <KeysManager keys={keys} defaultProvider={project?.default_provider} />
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded bg-teal/15 p-2 text-teal-dark">
              <Shuffle className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-lg font-semibold text-ink">Or use one router key</h3>
              <p className="mt-1 text-sm text-ink-soft">
                A router (LLM gateway) reaches several assistants with a single key, so you
                can skip the per-provider keys above. Runs are still recorded under the
                assistant that answered, so switching between a direct key and a router
                keeps one continuous history.
              </p>
            </div>
          </div>
          <RoutersManager keys={routerKeys} />
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded bg-butter-tint p-2 text-butter-ink">
              <Building2 className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-lg font-semibold text-ink">Organization</h3>
              <p className="mt-1 text-sm text-ink-soft">
                {project
                  ? `Settings for ${project.brand_name}, the organization selected in the sidebar. Tune how we recognize this brand across AI answers.`
                  : "Fill this in to get started, it powers prompt generation and mention detection."}
              </p>
            </div>
          </div>
          <ProjectForm
            project={project}
            configuredProviders={payerKeys.map((k) => k.provider)}
            routerKeys={routerCoverage}
            onTrial={
              trialEnabled() && payerKeys.length === 0 && payerRouterKeys.length === 0
            }
          />
        </CardBody>
      </Card>

      {project && team && (
        <Card>
          <CardBody className="space-y-5">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 rounded bg-mint-tint p-2 text-mint-ink">
                <Users className="h-5 w-5" />
              </span>
              <div>
                <h3 className="text-lg font-semibold text-ink">Team</h3>
                <p className="mt-1 text-sm text-ink-soft">
                  {isOwner
                    ? `Invite people into ${project.brand_name || project.name} by email. They get their own sign-in and work alongside you on this organization — everything below applies to this organization only, not to your others.`
                    : `Who else is in ${project.brand_name || project.name}. ${team.members[0]?.email ?? "The owner"} runs this organization.`}
                </p>
              </div>
            </div>
            <TeamManager
              members={team.members}
              invites={team.invites}
              isOwner={isOwner}
              viewerId={user.id}
              organization={project.brand_name || project.name}
            />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="space-y-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded bg-teal/15 p-2 text-teal-dark">
              <Plug className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-lg font-semibold text-ink">API &amp; MCP access</h3>
              <p className="mt-1 text-sm text-ink-soft">
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

      <Card>
        <CardBody className="space-y-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded bg-sand-tint p-2 text-ink-soft">
              <Palette className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-lg font-semibold text-ink">Appearance</h3>
              <p className="mt-1 text-sm text-ink-soft">
                Lettertrace defaults to dark. Switch to light if you prefer, your
                choice is remembered on this device.
              </p>
            </div>
          </div>
          <div className="max-w-xs">
            <ThemeSwitch />
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
