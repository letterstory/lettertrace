import { createClient } from "@/lib/supabase/server";
import { Onboarding } from "../onboarding";

export const dynamic = "force-dynamic";

// Add another organization to the account: same wizard as first-run onboarding.
// Completing it creates the org, makes it active, and runs its first monitor.
//
// Deliberately ungated. Setting up a brand is configuration; the free-run
// allowance is counted per account, so extra orgs cannot spend more of it.
export default async function NewOrganizationPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  return <Onboarding />;
}
