"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button, Input, Textarea, Select, Label, Spinner } from "@/components/ui";
import type { Project, Schedule } from "@/lib/types";

const SCHEDULE_LABELS: Record<Schedule, string> = {
  off: "Manual only",
  daily: "Daily",
  weekly: "Weekly",
};

export default function ProjectForm({ project }: { project: Project | null }) {
  const router = useRouter();

  const [name, setName] = useState(project?.name ?? "");
  const [brandName, setBrandName] = useState(project?.brand_name ?? "");
  const [brandAliases, setBrandAliases] = useState(
    (project?.brand_aliases ?? []).join(", "),
  );
  const [brandDomain, setBrandDomain] = useState(project?.brand_domain ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [schedule, setSchedule] = useState<Schedule>(project?.schedule ?? "off");

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const aliases = brandAliases
        .split(",")
        .map((a) => a.trim())
        .filter((a) => a.length > 0);

      const res = await fetch("/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          brand_name: brandName,
          brand_aliases: aliases,
          brand_domain: brandDomain,
          description,
          schedule,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || "Something went wrong. Please try again.");
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="p-name">Workspace name</Label>
          <Input
            id="p-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
            placeholder="My monitoring workspace"
            required
          />
        </div>
        <div>
          <Label htmlFor="p-brand">Brand name</Label>
          <Input
            id="p-brand"
            value={brandName}
            onChange={(e) => {
              setBrandName(e.target.value);
              setSaved(false);
            }}
            placeholder="Acme"
            required
          />
        </div>
      </div>

      <div>
        <Label htmlFor="p-aliases">Brand aliases</Label>
        <Input
          id="p-aliases"
          value={brandAliases}
          onChange={(e) => {
            setBrandAliases(e.target.value);
            setSaved(false);
          }}
          placeholder="Acme, Acme Inc, acme.com"
        />
        <p className="mt-1.5 text-xs text-ink-faint">
          Comma-separated. Other names people might use for your brand.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="p-domain">Brand domain</Label>
          <Input
            id="p-domain"
            value={brandDomain}
            onChange={(e) => {
              setBrandDomain(e.target.value);
              setSaved(false);
            }}
            placeholder="acme.com"
          />
        </div>
        <div>
          <Label htmlFor="p-schedule">Monitoring schedule</Label>
          <Select
            id="p-schedule"
            value={schedule}
            onChange={(e) => {
              setSchedule(e.target.value as Schedule);
              setSaved(false);
            }}
          >
            {(["off", "daily", "weekly"] as Schedule[]).map((s) => (
              <option key={s} value={s}>
                {SCHEDULE_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div>
        <Label htmlFor="p-desc">Description</Label>
        <Textarea
          id="p-desc"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            setSaved(false);
          }}
          placeholder="What does your brand do? This helps generate better monitoring prompts."
        />
      </div>

      {error && <p className="text-sm text-terracotta">{error}</p>}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving && <Spinner />}
          {saving ? "Saving..." : "Save changes"}
        </Button>
        {saved && !saving && (
          <span className="inline-flex items-center gap-1.5 text-sm text-ink-soft">
            <Check className="h-4 w-4 text-emerald-600" />
            Saved
          </span>
        )}
      </div>
    </form>
  );
}
