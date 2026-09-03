"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";

/**
 * The one button that spends an invitation.
 *
 * A POST rather than following the link, because the link itself is fetched by
 * mail scanners and previewers before anyone reads it. Accepting has to be
 * something a person did.
 */
export function AcceptInvite({
  token,
  alreadyMember,
}: {
  token: string;
  alreadyMember: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/invite/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error || "Could not accept the invitation. Try again.");
        return;
      }
      // The route has already pointed the dashboard at this organization, so
      // a plain push lands them inside it. refresh() first, because the layout
      // caches the org list this navigation is about to render.
      router.refresh();
      router.push("/dashboard");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (alreadyMember) {
    return (
      <Button href="/dashboard" size="lg" className="w-full">
        Open the dashboard
      </Button>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded border border-terracotta/40 bg-terracotta/[0.06] px-3 py-2 text-sm text-terracotta-dark">
          {error}
        </p>
      )}
      <Button onClick={accept} loading={busy} loadingText="Joining…" size="lg" className="w-full">
        Accept invitation
      </Button>
      <Button href="/dashboard" variant="secondary" size="lg" className="w-full">
        Not now
      </Button>
    </div>
  );
}
