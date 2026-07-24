import { KeyRound, Building2, Palette } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProject, getProviderKeysPublic } from "@/lib/data";
import { Card, CardBody, SectionHeading } from "@/components/ui";
import { ThemeSwitch } from "@/components/theme";
import KeysManager from "./keys-manager";
import ProjectForm from "./project-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [project, keys] = await Promise.all([
    getProject(supabase, user.id),
    getProviderKeysPublic(supabase, user.id),
  ]);

  return (
    <div className="space-y-8">
      <SectionHeading
        title="Settings"
        description="Connect your own model keys and describe the brand you want to monitor."
      />

      <Card>
        <CardBody className="space-y-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded-xl bg-mint-tint p-2 text-mint-ink">
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
            <span className="mt-0.5 rounded-xl bg-butter-tint p-2 text-butter-ink">
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
            <span className="mt-0.5 rounded-xl bg-sand-tint p-2 text-ink-soft">
              <Palette className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-lg font-semibold text-ink">Appearance</h3>
              <p className="mt-1 text-sm text-ink-faint">
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
