import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getConfiguredProviders, getProjects } from "@/lib/data";
import { Onboarding } from "../onboarding";

export const dynamic = "force-dynamic";

// Add another organization to the account: same wizard as first-run onboarding.
// Completing it creates the org, makes it active, and runs its first monitor.
//
// Gated to match the switcher — the nav item is hidden without a key, but the
// route is reachable by URL, and completing it would spend a free run on an
// org that can't produce a usable result yet.
export default async function NewOrganizationPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [projects, providers] = await Promise.all([
    getProjects(supabase, user.id),
    getConfiguredProviders(supabase, user.id),
  ]);

  if (projects.length > 0 && providers.length === 0) {
    redirect("/dashboard/settings?needKey=1");
  }

  return <Onboarding />;
}
