import { Onboarding } from "../onboarding";

export const dynamic = "force-dynamic";

// Add another organization to the account: same wizard as first-run onboarding.
// Completing it creates the org, makes it active, and runs its first monitor.
export default function NewOrganizationPage() {
  return <Onboarding />;
}
