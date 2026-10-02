"use client";

import { useState } from "react";

export function ReportEmailToggle({ enabled, isOwner }: { enabled: boolean; isOwner: boolean }) {
  const [checked, setChecked] = useState(enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/project/report-emails", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? "Could not save report email preference. Try again.");
      setChecked(result.enabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save report email preference. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-3 text-sm text-ink">
        <input
          type="checkbox"
          checked={checked}
          disabled={!isOwner || saving}
          onChange={(event) => void change(event.target.checked)}
          className="h-4 w-4 accent-terracotta"
        />
        Send reports to my inbox
      </label>
      <p className="text-sm text-ink-soft">
        {isOwner
          ? "Receive all reports directly by email. Maximum one report per day. Unsubscribe at any time."
          : "Only the organization owner can change report email delivery."}
      </p>
      {error && <p className="text-sm text-terracotta">{error}</p>}
    </div>
  );
}
