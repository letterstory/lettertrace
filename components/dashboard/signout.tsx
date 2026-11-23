"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";
import { resetProductPosthog } from "@/components/posthog-browser";
import { clearTrialEndedDismiss } from "@/components/dashboard/trial-ended-modal";

export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();

  async function handleSignOut() {
    resetProductPosthog();
    // Maybe later is per sign-in. Leaving the flag set made the next sign-in
    // in this same tab skip the modal.
    try {
      clearTrialEndedDismiss(sessionStorage);
    } catch {
      // A storage throw still signs them out. The next tab shows the modal.
    }
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleSignOut} className={className}>
      <LogOut className="h-4 w-4" aria-hidden />
      Sign out
    </Button>
  );
}
