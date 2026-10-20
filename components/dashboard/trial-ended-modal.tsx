"use client";

import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, ExternalLink, Info, KeyRound, Plus } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { PROVIDERS } from "@/lib/models";
import { ROUTERS } from "@/lib/routers";
import type { Provider, RouterId } from "@/lib/types";

// Shown once the owner's complimentary runs are spent, over a dashboard they
// can still read. Dismissal lives in sessionStorage rather than on the
// profile: the ask comes back next visit until a key exists, and a saved key
// is what actually ends it — the layout stops mounting this. A profile flag
// would make "Maybe later" permanent, which is the founder-call rule and the
// wrong one here.
//
// A router is a credential, not an answer engine, so OpenRouter, Concentrate,
// and Merge post to /api/router-keys. Sending them to /api/keys would be
// rejected, and labelling the run as the gateway would split the trend line.

const DISMISS_PREFIX = "lettertrace:trial-ended:";

export function trialEndedStorageKey(userId: string): string {
  return `${DISMISS_PREFIX}${userId}`;
}

export type TrialEndedEntry =
  | { id: string; kind: "provider"; provider: Provider; apiKey: string }
  | { id: string; kind: "router"; router: RouterId; apiKey: string };

export type TrialEndedRequest = {
  id: string;
  url: "/api/keys" | "/api/router-keys";
  body: { provider: Provider; apiKey: string } | { router: RouterId; apiKey: string };
};

/** One request per non-empty field. Empty input is not a save. */
export function trialEndedRequests(entries: TrialEndedEntry[]): TrialEndedRequest[] {
  const requests: TrialEndedRequest[] = [];
  for (const entry of entries) {
    const apiKey = entry.apiKey.trim();
    if (!apiKey) continue;
    if (entry.kind === "provider") {
      requests.push({
        id: entry.id,
        url: "/api/keys",
        body: { provider: entry.provider, apiKey },
      });
    } else {
      requests.push({
        id: entry.id,
        url: "/api/router-keys",
        body: { router: entry.router, apiKey },
      });
    }
  }
  return requests;
}

type HelpCopy = {
  where: string;
  looksLike: string;
  steps: string[];
  warning: string;
  linkLabel: string;
  /** Extra fact that belongs in the open panel, not on the closed card. */
  note?: string;
};

function keyHost(url: string): string {
  return new URL(url).host.replace(/^www\./, "");
}

const LOST_KEY = "Lost it? You can't view a key again. Create a new one and delete the old.";

function claudeHelp(url: string): HelpCopy {
  const host = keyHost(url);
  return {
    where: `Claude Console → Settings → API keys (${host})`,
    looksLike: "sk-ant-api03-…",
    steps: [
      `Go to ${host} and sign in, or create a free Console account.`,
      "Open Billing and add credits. The API is billed separately from a Claude Pro or Max subscription.",
      'Open Settings → API keys and click Create key. Name it something like "Lettertrace".',
      "Copy the key and paste it above. The Console only shows it once.",
    ],
    warning: LOST_KEY,
    linkLabel: "Open Claude Console",
  };
}

function openaiHelp(url: string): HelpCopy {
  const host = keyHost(url);
  return {
    where: `API keys (${host})`,
    looksLike: "sk-proj-…",
    steps: [
      `Go to ${host} and sign in, or create an account.`,
      "Open Billing and add credits. The API is billed separately from a ChatGPT Plus or Pro subscription.",
      'Open API keys and click Create new secret key. Name it something like "Lettertrace".',
      "Copy the key and paste it above. The platform only shows it once.",
    ],
    warning: LOST_KEY,
    linkLabel: "Open OpenAI API keys",
  };
}

function openrouterHelp(url: string): HelpCopy {
  const host = keyHost(url);
  return {
    where: `Settings → Keys (${host})`,
    looksLike: "sk-or-v1-…",
    steps: [
      `Go to ${host} and sign in, or create an account.`,
      "Open Credits and add some. OpenRouter bills the model you call.",
      'Open Settings → Keys and click Create. Name it something like "Lettertrace".',
      "Copy the key and paste it above. OpenRouter only shows it once.",
    ],
    warning: LOST_KEY,
    linkLabel: "Open OpenRouter keys",
    // GPT and Gemini search on this router are "none" (lib/routers.ts): a
    // grounded run through it would measure a different search engine and
    // still be labelled ChatGPT or Gemini. The closed card stays the short
    // label; this is the moment they're about to go create the key.
    note: "A monitored run through this key measures Claude. Grounded ChatGPT and Gemini still need their own keys.",
  };
}

type FeaturedCard = {
  id: string;
  entry: TrialEndedEntry;
  letter: string;
  title: string;
  hint: string;
  question: string;
  placeholder: string;
  url: string;
  help: HelpCopy;
};

const FEATURED: FeaturedCard[] = [
  {
    id: "anthropic",
    entry: { id: "anthropic", kind: "provider", provider: "anthropic", apiKey: "" },
    letter: "C",
    title: "Anthropic (Claude)",
    hint: "Claude models",
    question: "How do I get a Claude API key?",
    placeholder: `${PROVIDERS.anthropic.keyPrefix}…`,
    url: PROVIDERS.anthropic.keyUrl,
    help: claudeHelp(PROVIDERS.anthropic.keyUrl),
  },
  {
    id: "openai",
    entry: { id: "openai", kind: "provider", provider: "openai", apiKey: "" },
    letter: "O",
    title: "OpenAI (ChatGPT)",
    hint: "GPT models",
    question: "How do I get an OpenAI API key?",
    // The console now issues project keys (`sk-proj-`). The catalog prefix
    // stays `sk-` because Settings still accepts older keys; this placeholder
    // is only a hint for someone creating one today.
    placeholder: "sk-proj-…",
    url: PROVIDERS.openai.keyUrl,
    help: openaiHelp(PROVIDERS.openai.keyUrl),
  },
  {
    id: "openrouter",
    entry: { id: "openrouter", kind: "router", router: "openrouter", apiKey: "" },
    letter: "R",
    title: "OpenRouter",
    hint: "Many models, one key",
    question: "How do I get an OpenRouter key?",
    placeholder: `${ROUTERS.openrouter.keyPrefix}…`,
    url: ROUTERS.openrouter.keyUrl,
    help: openrouterHelp(ROUTERS.openrouter.keyUrl),
  },
];

type OtherField = {
  id: string;
  label: string;
  placeholder: string;
  entry: TrialEndedEntry;
};

function otherPlaceholder(prefix: string): string {
  return prefix ? `${prefix}…` : "API key";
}

const OTHERS: OtherField[] = [
  {
    id: "google",
    label: "Gemini",
    placeholder: otherPlaceholder(PROVIDERS.google.keyPrefix),
    entry: { id: "google", kind: "provider", provider: "google", apiKey: "" },
  },
  {
    id: "perplexity",
    label: "Perplexity",
    placeholder: otherPlaceholder(PROVIDERS.perplexity.keyPrefix),
    entry: { id: "perplexity", kind: "provider", provider: "perplexity", apiKey: "" },
  },
  {
    id: "concentrate",
    label: "Concentrate",
    placeholder: otherPlaceholder(ROUTERS.concentrate.keyPrefix),
    entry: { id: "concentrate", kind: "router", router: "concentrate", apiKey: "" },
  },
  {
    id: "merge",
    label: "Merge",
    placeholder: otherPlaceholder(ROUTERS.merge.keyPrefix),
    entry: { id: "merge", kind: "router", router: "merge", apiKey: "" },
  },
];

function helpId(id: string): string {
  return `trial-ended-help-${id}`;
}

export function TrialEndedModal({
  userId,
  used,
  limit,
}: {
  userId: string;
  used: number;
  limit: number;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(trialEndedStorageKey(userId)) !== "1") setOpen(true);
    } catch {
      // A private-mode throw is one extra showing, which is the lesser miss.
      setOpen(true);
    }
  }, [userId]);

  function dismiss() {
    try {
      sessionStorage.setItem(trialEndedStorageKey(userId), "1");
    } catch {
      // The in-memory close still holds until a reload.
    }
    setOpen(false);
  }

  if (!open) return null;
  return <TrialEndedPortal used={used} limit={limit} onDismiss={dismiss} onSaved={() => setOpen(false)} />;
}

function TrialEndedPortal({
  used,
  limit,
  onDismiss,
  onSaved,
}: {
  used: number;
  limit: number;
  onDismiss: () => void;
  onSaved: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onDismiss]);

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="trial-ended-title"
    >
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={onDismiss} />
      <TrialEndedDialog used={used} limit={limit} onDismiss={onDismiss} onSaved={onSaved} />
    </div>,
    document.body,
  );
}

export function TrialEndedDialog({
  used,
  limit,
  onDismiss,
  onSaved,
}: {
  used: number;
  limit: number;
  onDismiss: () => void;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [openHelp, setOpenHelp] = useState<string>("anthropic");
  const [othersOpen, setOthersOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const entries = [...FEATURED, ...OTHERS].map((field) => ({
    ...field.entry,
    apiKey: values[field.id] ?? "",
  }));
  const canSave = trialEndedRequests(entries).length > 0;

  function setValue(id: string, apiKey: string) {
    setValues((prev) => ({ ...prev, [id]: apiKey }));
    setFormError(null);
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const requests = trialEndedRequests(entries);
    if (requests.length === 0) {
      setFormError("Add one key to continue.");
      return;
    }
    setSaving(true);
    setFormError(null);
    setErrors({});
    try {
      const results = await Promise.all(
        requests.map(async (req) => {
          try {
            const res = await fetch(req.url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(req.body),
            });
            const data = (await res.json().catch(() => null)) as { error?: string } | null;
            if (!res.ok) {
              return {
                id: req.id,
                ok: false as const,
                error: data?.error || "Something went wrong. Please try again.",
              };
            }
            return { id: req.id, ok: true as const };
          } catch {
            return { id: req.id, ok: false as const, error: "Network error. Please try again." };
          }
        }),
      );
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) {
        router.refresh();
        onSaved();
        return;
      }
      setValues((prev) => {
        const next = { ...prev };
        for (const result of results) {
          if (result.ok) next[result.id] = "";
        }
        return next;
      });
      setErrors(
        Object.fromEntries(failed.map((result) => [result.id, result.error ?? "Something went wrong. Please try again."])),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={handleSave}
      className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-[640px] flex-col overflow-y-auto rounded-[16px] border border-ink/10 bg-surface p-5 shadow-lift sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal/15 text-teal">
          <KeyRound className="h-4 w-4" />
        </span>
        <p className="rounded-full border border-terracotta/30 bg-terracotta/15 px-2.5 py-1 text-[11px] font-medium text-terracotta-dark">
          {used} of {limit} free runs used
        </p>
      </div>

      <h2 id="trial-ended-title" className="mt-4 font-serif text-2xl font-semibold tracking-tight text-ink">
        Your complimentary runs are up
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        Thanks for trying Lettertrace on the house. To keep running reports, add an API key from one
        of these providers. You only need one.
      </p>

      <div className="mt-5 space-y-3">
        {FEATURED.map((card) => (
          <FeaturedProvider
            key={card.id}
            card={card}
            value={values[card.id] ?? ""}
            error={errors[card.id] ?? null}
            expanded={openHelp === card.id}
            onToggle={() => setOpenHelp((current) => (current === card.id ? "" : card.id))}
            onChange={(value) => setValue(card.id, value)}
          />
        ))}

        <div className="rounded-xl border border-dashed border-ink/15">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-3 text-left"
            aria-expanded={othersOpen}
            aria-controls="trial-ended-others"
            onClick={() => setOthersOpen((open) => !open)}
          >
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-ink/15 text-ink-faint">
              <Plus className="h-3.5 w-3.5" />
            </span>
            <span className="text-sm font-semibold text-ink">Others</span>
            <span className="ml-auto truncate text-xs text-ink-faint">
              Gemini, Perplexity, Concentrate & Merge
            </span>
            {othersOpen ? (
              <ChevronUp className="h-4 w-4 shrink-0 text-ink-faint" />
            ) : (
              <ChevronDown className="h-4 w-4 shrink-0 text-ink-faint" />
            )}
          </button>
          {othersOpen && (
            <div id="trial-ended-others" className="space-y-3 border-t border-ink/10 px-3 py-3">
              {OTHERS.map((field) => (
                <label key={field.id} className="block">
                  <span className="mb-1.5 block text-xs font-medium text-ink-soft">{field.label}</span>
                  <Input
                    type="password"
                    value={values[field.id] ?? ""}
                    onChange={(e) => setValue(field.id, e.target.value)}
                    placeholder={field.placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={`${field.label} API key`}
                  />
                  {errors[field.id] && (
                    <p className="mt-1.5 text-sm text-terracotta-dark">{errors[field.id]}</p>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      {formError && <p className="mt-3 text-sm text-terracotta-dark">{formError}</p>}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <p className="mr-auto max-w-[16rem] text-xs leading-relaxed text-ink-faint">
          Usage is billed by your provider, not Lettertrace.
        </p>
        <Button type="button" variant="secondary" size="sm" onClick={onDismiss}>
          Maybe later
        </Button>
        <Button type="submit" size="sm" disabled={!canSave} loading={saving} loadingText="Verifying…">
          Save key & continue
        </Button>
      </div>
    </form>
  );
}

function FeaturedProvider({
  card,
  value,
  error,
  expanded,
  onToggle,
  onChange,
}: {
  card: FeaturedCard;
  value: string;
  error: string | null;
  expanded: boolean;
  onToggle: () => void;
  onChange: (value: string) => void;
}) {
  const host = keyHost(card.url);
  const panelId = helpId(card.id);
  return (
    <div className="rounded-xl border border-ink/10 bg-paper/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-ink/15 text-[11px] font-semibold text-ink">
          {card.letter}
        </span>
        <p className="text-sm font-semibold text-ink">{card.title}</p>
        <span className="ml-auto text-xs text-ink-faint">{card.hint}</span>
        <a
          href={card.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-full border border-terracotta/40 bg-terracotta/10 px-2 py-0.5 text-[11px] font-medium text-terracotta-dark transition hover:bg-terracotta/20"
        >
          {host}
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      <Input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={card.placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-label={`${card.title} API key`}
        className="mt-3"
      />
      {error && <p className="mt-1.5 text-sm text-terracotta-dark">{error}</p>}

      <button
        type="button"
        className="mt-2 flex w-full items-center gap-2 rounded px-1 py-1.5 text-left text-sm text-ink-soft transition hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <Info className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        <span>{card.question}</span>
        {expanded ? (
          <ChevronUp className="ml-auto h-4 w-4 shrink-0 text-ink-faint" />
        ) : (
          <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-ink-faint" />
        )}
      </button>

      {expanded && <HelpPanel id={panelId} url={card.url} help={card.help} />}
    </div>
  );
}

function HelpPanel({ id, url, help }: { id: string; url: string; help: HelpCopy }) {
  return (
    <div id={id} className="mt-2 rounded-xl border border-help-border bg-help p-3 text-help-ink">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-help-deep-border bg-help-deep p-3">
          <p className="text-[10px] font-semibold tracking-wider text-help-ink/80">WHERE IT LIVES</p>
          <p className="mt-1 text-sm leading-snug">{help.where}</p>
        </div>
        <div className="rounded-lg border border-help-deep-border bg-help-deep p-3">
          <p className="text-[10px] font-semibold tracking-wider text-help-ink/80">LOOKS LIKE</p>
          <p className="mt-1 font-mono text-sm">{help.looksLike}</p>
        </div>
      </div>

      <ol className="mt-3 space-y-2">
        {help.steps.map((step, index) => (
          <li key={step} className="flex gap-2 text-sm leading-snug">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-help-deep text-[11px] font-semibold">
              {index + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>

      <div className="mt-3 flex gap-2 rounded-lg border border-help-deep-border bg-help-deep px-3 py-2 text-sm leading-snug">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>{help.warning}</p>
      </div>

      {help.note && <p className="mt-3 text-sm leading-snug">{help.note}</p>}

      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-help-deep-border bg-help-deep px-3 py-1.5 text-sm font-medium transition hover:bg-help-deep/80"
      >
        {help.linkLabel}
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}
