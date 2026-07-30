"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Building2, Plus, Search, Sparkles, Trash2, Users, X } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Input,
  Label,
  Spinner,
} from "@/components/ui";
import type { Competitor } from "@/lib/types";
import { NeedsKeyNotice } from "@/components/dashboard/needs-key-notice";
import { article } from "@/lib/utils";

const ALIAS_TONES = ["teal", "sand", "mint"] as const;

interface Suggestion {
  name: string;
  domain: string | null;
  aliases: string[];
  reason: string;
}

function parseAliases(raw: string): string[] {
  return raw
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

export function CompetitorsClient({
  competitors,
  hasKey,
  providerLabel,
}: {
  competitors: Competitor[];
  hasKey: boolean;
  providerLabel: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [domain, setDomain] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  // AI competitor suggestions. `null` = not asked yet.
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [addingSuggestion, setAddingSuggestion] = useState<string | null>(null);

  // Companies the stored answers already named. Distinct from the AI
  // suggestions above: these are grounded in what the models actually said
  // about this brand's prompts, not in the model's general knowledge, and they
  // cost no provider call. `null` = not asked yet.
  const [found, setFound] = useState<
    { companies: { name: string; answers: number }[]; answersScanned: number } | null
  >(null);
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);

  async function handleFind() {
    if (finding) return;
    setFinding(true);
    setFindError(null);
    try {
      const res = await fetch("/api/competitors/discovered");
      const json = await res.json();
      if (!res.ok) {
        setFindError(json.error ?? "Could not scan your answers.");
        return;
      }
      setFound({ companies: json.companies ?? [], answersScanned: json.answersScanned ?? 0 });
    } catch {
      setFindError("Network error. Please try again.");
    } finally {
      setFinding(false);
    }
  }

  async function handleTrackFound(name: string) {
    if (addingSuggestion) return;
    setAddingSuggestion(name);
    setFindError(null);
    try {
      const res = await fetch("/api/competitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, aliases: [], domain: null }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setFindError(json.error ?? "Could not add competitor.");
        return;
      }
      setFound((prev) =>
        prev ? { ...prev, companies: prev.companies.filter((c) => c.name !== name) } : prev,
      );
      router.refresh();
    } catch {
      setFindError("Network error. Please try again.");
    } finally {
      setAddingSuggestion(null);
    }
  }

  async function handleSuggest() {
    if (suggesting) return;
    setSuggesting(true);
    setSuggestError(null);
    try {
      const res = await fetch("/api/competitors/suggest", { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        setSuggestError(json.error ?? "Could not fetch suggestions.");
        return;
      }
      const fresh: Suggestion[] = Array.isArray(json.suggestions) ? json.suggestions : [];
      setSuggestions(fresh);
    } catch {
      setSuggestError("Network error. Please try again.");
    } finally {
      setSuggesting(false);
    }
  }

  async function handleAddSuggestion(s: Suggestion) {
    if (addingSuggestion) return;
    setAddingSuggestion(s.name);
    setSuggestError(null);
    try {
      const res = await fetch("/api/competitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: s.name, aliases: s.aliases, domain: s.domain }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setSuggestError(json.error ?? "Could not add competitor.");
        return;
      }
      setSuggestions((prev) => (prev ?? []).filter((x) => x.name !== s.name));
      router.refresh();
    } catch {
      setSuggestError("Network error. Please try again.");
    } finally {
      setAddingSuggestion(null);
    }
  }

  function dismissSuggestion(name: string) {
    setSuggestions((prev) => (prev ?? []).filter((x) => x.name !== name));
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/competitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          aliases: parseAliases(aliases),
          domain: domain.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Something went wrong.");
        return;
      }
      setName("");
      setAliases("");
      setDomain("");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemove(id: string) {
    if (removingId) return;
    setRemovingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/competitors/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? "Could not remove competitor.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="space-y-8">
      <Card>
        <CardBody>
          <h3 className="text-lg font-semibold text-ink">Add a competitor</h3>
          <p className="mt-1 text-sm text-ink-soft">
            Aliases and domain help Lettertrace catch every way an AI answer might refer to them.
          </p>
          <form onSubmit={handleAdd} className="mt-5 grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-1">
              <Label htmlFor="competitor-name">Name</Label>
              <Input
                id="competitor-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Co."
                required
              />
            </div>
            <div className="sm:col-span-1">
              <Label htmlFor="competitor-aliases">Aliases</Label>
              <Input
                id="competitor-aliases"
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
                placeholder="Acme, AcmeCorp"
              />
            </div>
            <div className="sm:col-span-1">
              <Label htmlFor="competitor-domain">Domain</Label>
              <Input
                id="competitor-domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="acme.com"
              />
            </div>
            <div className="flex items-center gap-3 sm:col-span-3">
              <Button
                type="submit"
                loading={submitting}
                loadingText="Adding…"
                disabled={!name.trim()}
              >
                Add competitor
              </Button>
              {error && <p className="text-sm text-terracotta-dark">{error}</p>}
            </div>
          </form>
        </CardBody>
      </Card>

      {/* Grounded in what the answers said, so it comes before the AI guesses. */}
      <Card>
        <CardBody>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 rounded bg-teal/15 p-2 text-teal-dark">
                <Search className="h-5 w-5" />
              </span>
              <div>
                <h3 className="text-lg font-semibold text-ink">
                  Named in your answers
                </h3>
                <p className="mt-1 text-sm text-ink-soft">
                  Companies the models already recommended for your prompts, that you
                  aren&apos;t tracking. Mention detection only looks for brands on your
                  list, so these are invisible until you add them. No API key needed.
                </p>
              </div>
            </div>
            <Button variant="secondary" onClick={handleFind} disabled={finding}>
              {finding ? <Spinner /> : <Search className="h-4 w-4" />}
              {found === null ? "Scan my answers" : "Scan again"}
            </Button>
          </div>

          {findError && <p className="mt-4 text-sm text-terracotta-dark">{findError}</p>}

          {found !== null && !finding && found.companies.length === 0 && !findError && (
            <p className="mt-4 text-sm text-ink-soft">
              {found.answersScanned === 0
                ? "No answers stored yet. Run your monitor first, then scan."
                : `Scanned ${found.answersScanned} answers and found no untracked companies. Your list looks complete.`}
            </p>
          )}

          {found !== null && found.companies.length > 0 && (
            <>
              <p className="mt-4 text-sm text-ink-soft">
                From {found.answersScanned} stored answer
                {found.answersScanned === 1 ? "" : "s"}.
                {found.companies[0].answers === 1 &&
                  " Every name appeared just once, so the models have no settled pick for this category yet."}
              </p>
              <ul className="mt-4 flex flex-wrap gap-2">
                {found.companies.map((c) => (
                  <li
                    key={c.name}
                    className="flex items-center gap-2 rounded border border-ink/10 bg-paper py-1.5 pl-3 pr-1.5"
                  >
                    <span className="text-sm font-medium text-ink">{c.name}</span>
                    <span className="text-xs text-ink-faint">
                      {c.answers} answer{c.answers === 1 ? "" : "s"}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleTrackFound(c.name)}
                      disabled={addingSuggestion !== null}
                      className="rounded p-1 text-terracotta-dark transition hover:bg-terracotta/10 disabled:opacity-50"
                      aria-label={`Track ${c.name}`}
                      title={`Track ${c.name}`}
                    >
                      {addingSuggestion === c.name ? (
                        <Spinner />
                      ) : (
                        <Plus className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 rounded bg-terracotta/10 p-2 text-terracotta">
                <Sparkles className="h-5 w-5" />
              </span>
              <div>
                <h3 className="text-lg font-semibold text-ink">Suggested competitors</h3>
                <p className="mt-1 text-sm text-ink-soft">
                  Let AI propose direct competitors based on your brand and topics. You decide
                  which ones to track.
                </p>
              </div>
            </div>
            <Button
              variant="secondary"
              onClick={handleSuggest}
              // Was enabled without a key, so the only feedback was a server
              // error after the click. Say so before it's spent instead.
              disabled={!hasKey || suggesting}
              title={!hasKey ? `Add ${article(providerLabel)} ${providerLabel} key in Settings to enable` : undefined}
            >
              {suggesting ? <Spinner /> : <Sparkles className="h-4 w-4" />}
              {suggestions === null ? "Suggest competitors" : "Suggest again"}
            </Button>
          </div>

          {!hasKey && (
            <NeedsKeyNotice
              compact
              className="mt-4"
              providerLabel={providerLabel}
              action="suggest competitors"
            />
          )}

          {suggestError && <p className="mt-4 text-sm text-terracotta-dark">{suggestError}</p>}

          {suggestions !== null && !suggesting && suggestions.length === 0 && !suggestError && (
            <p className="mt-4 text-sm text-ink-faint">
              No new suggestions right now, you may already be tracking the main players.
            </p>
          )}

          {suggestions !== null && suggestions.length > 0 && (
            <ul className="mt-5 space-y-3">
              {suggestions.map((s) => (
                <li
                  key={s.name}
                  className="flex flex-wrap items-center justify-between gap-3 rounded border border-ink/10 bg-paper p-4"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-ink">{s.name}</p>
                      {s.domain && (
                        <span className="inline-flex items-center gap-1 text-sm text-ink-faint">
                          <Building2 className="h-3.5 w-3.5" />
                          {s.domain}
                        </span>
                      )}
                    </div>
                    {s.reason && <p className="mt-1 text-sm text-ink-faint">{s.reason}</p>}
                    {s.aliases.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {s.aliases.map((alias, i) => (
                          <Badge key={`${alias}-${i}`} tone={ALIAS_TONES[i % ALIAS_TONES.length]}>
                            {alias}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => handleAddSuggestion(s)}
                      disabled={addingSuggestion !== null}
                    >
                      {addingSuggestion === s.name ? <Spinner /> : <Plus className="h-4 w-4" />}
                      Track
                    </Button>
                    <button
                      type="button"
                      onClick={() => dismissSuggestion(s.name)}
                      className="rounded p-2 text-ink-faint transition hover:bg-ink/5 hover:text-terracotta-dark"
                      aria-label={`Dismiss ${s.name}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {competitors.length === 0 ? (
        <EmptyState
          icon={<Users className="h-8 w-8" />}
          title="No competitors yet"
          description="Add the first brand you want to benchmark against to start tracking share of voice."
        />
      ) : (
        <div className="space-y-3">
          {competitors.map((competitor) => (
            <Card key={competitor.id}>
              <CardBody className="flex flex-wrap items-center justify-between gap-4 p-5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-ink">{competitor.name}</p>
                    {competitor.domain && (
                      <span className="inline-flex items-center gap-1 text-sm text-ink-faint">
                        <Building2 className="h-3.5 w-3.5" />
                        {competitor.domain}
                      </span>
                    )}
                  </div>
                  {competitor.aliases.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {competitor.aliases.map((alias, i) => (
                        <Badge key={`${alias}-${i}`} tone={ALIAS_TONES[i % ALIAS_TONES.length]}>
                          {alias}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => handleRemove(competitor.id)}
                  disabled={removingId === competitor.id}
                >
                  {removingId === competitor.id ? <Spinner /> : <Trash2 className="h-4 w-4" />}
                  Remove
                </Button>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
