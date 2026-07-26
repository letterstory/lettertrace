"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button, Input, Textarea, Select, Label, Spinner } from "@/components/ui";
import { PROVIDER_LIST } from "@/lib/models";
import type { Project, Schedule } from "@/lib/types";

const SCHEDULE_LABELS: Record<Schedule, string> = {
  off: "Manual only",
  daily: "Daily",
  weekly: "Weekly",
};

// The answer engine is stored as a (provider, model) pair; the picker packs
// both into one "provider:model" option value and unpacks on submit.
const DEFAULT_ENGINE = `${PROVIDER_LIST[0].id}:${PROVIDER_LIST[0].models[0].id}`;

function splitEngine(value: string): { provider: string; model: string } {
  const sep = value.indexOf(":");
  return sep === -1
    ? { provider: value, model: "" }
    : { provider: value.slice(0, sep), model: value.slice(sep + 1) };
}

export default function ProjectForm({ project }: { project: Project | null }) {
  const router = useRouter();

  const [name, setName] = useState(project?.name ?? "");
  const [brandName, setBrandName] = useState(project?.brand_name ?? "");
  const [brandAliases, setBrandAliases] = useState(
    (project?.brand_aliases ?? []).join(", "),
  );
  const [brandDomains, setBrandDomains] = useState(
    (project?.brand_domains ?? []).join(", "),
  );
  const [description, setDescription] = useState(project?.description ?? "");
  const [schedule, setSchedule] = useState<Schedule>(project?.schedule ?? "off");
  const [useWebSearch, setUseWebSearch] = useState(project?.use_web_search ?? true);
  const [engine, setEngine] = useState(
    project ? `${project.default_provider}:${project.default_model}` : DEFAULT_ENGINE,
  );

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

      const { provider: default_provider, model: default_model } = splitEngine(engine);

      const res = await fetch("/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          brand_name: brandName,
          brand_aliases: aliases,
          brand_domains: brandDomains,
          description,
          schedule,
          use_web_search: useWebSearch,
          default_provider,
          default_model,
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
          <Label htmlFor="p-domains">Brand domains</Label>
          <Input
            id="p-domains"
            value={brandDomains}
            onChange={(e) => {
              setBrandDomains(e.target.value);
              setSaved(false);
            }}
            placeholder="acme.com, acme-guides.com"
          />
          <p className="mt-1.5 text-xs text-ink-faint">
            Comma-separated, main domain first. Sources cited from any of these
            count as yours — include phantom sites for this brand.
          </p>
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
        <Label htmlFor="p-engine">Answer engine</Label>
        <Select
          id="p-engine"
          value={engine}
          onChange={(e) => {
            setEngine(e.target.value);
            setSaved(false);
          }}
        >
          {PROVIDER_LIST.map((info) => (
            <optgroup key={info.id} label={info.label}>
              {info.models.map((m) => (
                <option key={`${info.id}:${m.id}`} value={`${info.id}:${m.id}`}>
                  {m.label}
                  {m.note ? ` · ${m.note}` : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        <p className="mt-1.5 text-xs text-ink-faint">
          Which assistant we query for this brand. You&apos;ll need a key for the
          matching provider in the section above. Google AI Overviews and Gemini both
          use your Google key.
        </p>
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

      <label
        htmlFor="p-websearch"
        className="flex cursor-pointer items-start justify-between gap-4 rounded-2xl border border-ink/10 bg-paper-shade/40 p-4"
      >
        <span>
          <span className="text-sm font-medium text-ink">Web search</span>
          <span className="mt-0.5 block text-xs text-ink-faint">
            Query the models with their native web search on and capture the sources they
            cite. More realistic answers and source attribution; costs a bit more per run.
          </span>
        </span>
        <button
          type="button"
          role="switch"
          id="p-websearch"
          aria-checked={useWebSearch}
          onClick={() => {
            setUseWebSearch((v) => !v);
            setSaved(false);
          }}
          className={
            "relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition " +
            (useWebSearch ? "bg-terracotta" : "bg-ink/15")
          }
        >
          <span
            className={
              "inline-block h-4 w-4 transform rounded-full bg-white transition " +
              (useWebSearch ? "translate-x-6" : "translate-x-1")
            }
          />
        </button>
      </label>

      {error && <p className="text-sm text-terracotta">{error}</p>}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving && <Spinner />}
          {saving ? "Saving..." : "Save changes"}
        </Button>
        {saved && !saving && (
          <span className="inline-flex items-center gap-1.5 text-sm text-ink-soft">
            <Check className="h-4 w-4 text-teal-dark" />
            Saved
          </span>
        )}
      </div>
    </form>
  );
}
