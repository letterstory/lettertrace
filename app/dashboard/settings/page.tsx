import { KeyRound, Building2 } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getProject, getProviderKeysPublic } from "@/lib/data";
import { Card, CardBody, SectionHeading } from "@/components/ui";
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
            <span className="mt-0.5 rounded-xl bg-mint/50 p-2 text-emerald-800">
              <KeyRound className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-lg font-semibold text-ink">API keys</h3>
              <p className="mt-1 text-sm text-ink-faint">
                Lettertrace never stores your keys in plaintext, they&apos;re
                encrypted at rest and only used to run your monitoring.
              </p>
            </div>
          </div>
          <KeysManager keys={keys} />
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
    </div>
  );
}
