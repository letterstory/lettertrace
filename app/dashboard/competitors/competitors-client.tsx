"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Building2, Plus, Sparkles, Trash2, Users, X } from "lucide-react";
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

export function CompetitorsClient({ competitors }: { competitors: Competitor[] }) {
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
          <p className="mt-1 text-sm text-ink-faint">
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
              <Button type="submit" disabled={submitting || !name.trim()}>
                {submitting && <Spinner />}
                Add competitor
              </Button>
              {error && <p className="text-sm text-terracotta-dark">{error}</p>}
            </div>
          </form>
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
                <p className="mt-1 text-sm text-ink-faint">
                  Let AI propose direct competitors based on your brand and topics. You decide
                  which ones to track.
                </p>
              </div>
            </div>
            <Button variant="secondary" onClick={handleSuggest} disabled={suggesting}>
              {suggesting ? <Spinner /> : <Sparkles className="h-4 w-4" />}
              {suggestions === null ? "Suggest competitors" : "Suggest again"}
            </Button>
          </div>

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
