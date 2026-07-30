"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button, Input, Textarea, Select, Label } from "@/components/ui";
import { PROVIDER_LIST, PROVIDERS } from "@/lib/models";
import { article } from "@/lib/utils";
import type { Project, Provider, Schedule } from "@/lib/types";

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

export default function ProjectForm({
  project,
  configuredProviders = [],
  onTrial = false,
}: {
  project: Project | null;
  /** Providers the user has a key for, so the picker can flag an engine that
   *  can't run before they discover it as a failed run. */
  configuredProviders?: Provider[];
  /** Running on the operator's shared keys, which force a cheaper model. The
   *  picker promises "the assistant we query", so on the trial that promise is
   *  only true of the provider, not the model. */
  onTrial?: boolean;
}) {
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

  // Reflects the CURRENT dropdown value, not the saved project, so the warning
  // appears while they're choosing rather than after the next failed run.
  const selectedProvider = splitEngine(engine).provider as Provider;
  const engineNeedsKey =
    Boolean(PROVIDERS[selectedProvider]) && !configuredProviders.includes(selectedProvider);

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
            count as yours. Include phantom sites for this brand.
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
        {engineNeedsKey ? (
          <p className="mt-1.5 text-xs text-terracotta">
            No {PROVIDERS[selectedProvider].label} key saved, so runs on this engine
            will fail. Add one in the section above, or pick an engine you have a key
            for. We never answer with a different assistant than the one selected.
          </p>
        ) : (
          <div className="mt-1.5 space-y-1">
            <p className="text-xs text-ink-faint">
              Which assistant we query for this brand. You&apos;ll need a key for the
              matching provider in the section above. Google AI Overviews and Gemini both
              use your Google key.
            </p>
            {onTrial && (
              <p className="text-xs text-ink-faint">
                While you&apos;re on free runs we use a faster, cheaper model from the
                same provider. Your own key runs exactly what you pick here.
              </p>
            )}
          </div>
        )}
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
        className="flex cursor-pointer items-start justify-between gap-4 rounded border border-ink/10 bg-paper-shade/40 p-4"
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
            "relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded transition " +
            (useWebSearch ? "bg-terracotta" : "bg-ink/15")
          }
        >
          <span
            className={
              "inline-block h-4 w-4 transform rounded-sm bg-white transition " +
              (useWebSearch ? "translate-x-6" : "translate-x-1")
            }
          />
        </button>
      </label>

      {error && <p className="text-sm text-terracotta">{error}</p>}

      <div className="flex items-center gap-3">
        <Button type="submit" loading={saving} loadingText="Saving…">
          Save changes
        </Button>
        {saved && !saving && (
          // A bare "Saved" was the whole complaint: an engine with no key
          // behind it saved as cheerfully as a working one, and the warning
          // above sits pre-submit where it reads as advice rather than as the
          // outcome. Qualify the confirmation with what is still missing.
          <span className="inline-flex items-center gap-1.5 text-sm text-ink-soft">
            <Check className="h-4 w-4 text-teal-dark" />
            {engineNeedsKey ? (
              <span>
                Saved, but runs need {article(PROVIDERS[selectedProvider].label)}{" "}
                {PROVIDERS[selectedProvider].label} key
              </span>
            ) : (
              "Saved"
            )}
          </span>
        )}
      </div>
    </form>
  );
}
