"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Badge, Button, Input, Spinner } from "@/components/ui";
import { cn, formatDate } from "@/lib/utils";
import { PROVIDER_LIST, type ProviderInfo } from "@/lib/models";
import type { Provider, ProviderKeyPublic } from "@/lib/types";

// "Your Claude key, your OpenAI key": one fixed card per provider instead of a
// generic list + dropdown form. Each card is either connected (masked hint,
// replace/remove) or an inline save form that verifies the key before storing.

// Brand glyphs (transparent PNGs in /public/providers) on the cards' tinted
// chips. OpenAI's mark is monochrome, so it carries a per-theme pair swapped by
// the .logo-for-* rules in globals.css; the others read on both themes as-is.
const PROVIDER_STYLE: Record<
  Provider,
  { title: string; subtitle: string; chipClass: string; logo: string; darkLogo?: string }
> = {
  anthropic: {
    title: "Claude",
    subtitle: "Anthropic API key",
    chipClass: "bg-terracotta/10",
    logo: "/providers/anthropic.png",
  },
  openai: {
    title: "ChatGPT",
    subtitle: "OpenAI API key",
    chipClass: "bg-teal/15",
    logo: "/providers/openai-black.png",
    darkLogo: "/providers/openai-white.png",
  },
  google: {
    title: "Gemini",
    subtitle: "Google AI key · also powers AI Overviews",
    chipClass: "bg-butter-tint",
    logo: "/providers/google.png",
  },
  perplexity: {
    title: "Perplexity",
    subtitle: "Sonar API key · answers are always search-grounded",
    chipClass: "bg-mint-tint",
    logo: "/providers/perplexity.png",
  },
};

export default function KeysManager({
  keys,
  defaultProvider,
}: {
  keys: ProviderKeyPublic[];
  defaultProvider?: Provider;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {PROVIDER_LIST.map((info) => (
        <ProviderCard
          key={info.id}
          info={info}
          existing={keys.find((k) => k.provider === info.id) ?? null}
          isDefault={info.id === defaultProvider}
        />
      ))}
    </div>
  );
}

function ProviderCard({
  info,
  existing,
  isDefault,
}: {
  info: ProviderInfo;
  existing: ProviderKeyPublic | null;
  isDefault: boolean;
}) {
  const router = useRouter();
  const style = PROVIDER_STYLE[info.id];

  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showForm = !existing || editing;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim() || verifying) return;
    setError(null);
    setVerifying(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: info.id, apiKey }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || "Something went wrong. Please try again.");
        return;
      }
      setApiKey("");
      setReveal(false);
      setEditing(false);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleRemove() {
    if (!existing || removing) return;
    setError(null);
    setRemoving(true);
    try {
      const res = await fetch(`/api/keys/${existing.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error || "Could not remove that key.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="flex flex-col rounded border border-ink/10 bg-paper p-5">
      {/* Header: identity + status */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "grid h-11 w-11 shrink-0 place-items-center rounded",
              style.chipClass,
            )}
            aria-hidden
          >
            {style.darkLogo ? (
              <>
                <img src={style.logo} alt="" className="logo-for-light h-6 w-6 object-contain" />
                <img src={style.darkLogo} alt="" className="logo-for-dark h-6 w-6 object-contain" />
              </>
            ) : (
              <img src={style.logo} alt="" className="h-6 w-6 object-contain" />
            )}
          </span>
          <div>
            <p className="font-serif text-lg font-semibold leading-tight text-ink">
              {style.title}
            </p>
            <p className="text-xs text-ink-faint">{style.subtitle}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isDefault && <Badge tone="terracotta">Default</Badge>}
          {existing ? (
            <Badge tone="mint">
              <CheckCircle2 className="h-3 w-3" />
              Connected
            </Badge>
          ) : (
            <Badge tone="neutral">Not connected</Badge>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="mt-4 flex-1">
        {existing && !editing && (
          <div className="flex items-center justify-between gap-3 rounded border border-ink/10 bg-paper-shade/50 px-4 py-3">
            <p className="font-mono text-sm text-ink">{existing.key_hint}</p>
            <p className="shrink-0 text-xs text-ink-faint">
              Added {formatDate(existing.created_at)}
            </p>
          </div>
        )}

        {showForm && (
          <form onSubmit={handleSave} className="space-y-3">
            <div className="relative">
              <Input
                type={reveal ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={`${info.keyPrefix}...`}
                autoComplete="off"
                spellCheck={false}
                aria-label={`${style.subtitle}`}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setReveal((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-faint transition hover:text-ink"
                aria-label={reveal ? "Hide key" : "Show key"}
                tabIndex={-1}
              >
                {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                size="sm"
                loading={verifying}
                loadingText="Verifying…"
                disabled={!apiKey.trim()}
              >
                Save key
              </Button>
              {editing && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditing(false);
                    setApiKey("");
                    setError(null);
                  }}
                >
                  Cancel
                </Button>
              )}
              <a
                href={info.keyUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-terracotta-dark transition hover:text-terracotta"
              >
                Get your key <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </form>
        )}

        {error && <p className="mt-3 text-sm text-terracotta-dark">{error}</p>}
      </div>

      {/* Footer actions / reassurance */}
      {existing && !editing ? (
        <div className="mt-4 flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setEditing(true);
              setError(null);
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Replace
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={handleRemove}
            disabled={removing}
          >
            {removing ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" />}
            Remove
          </Button>
        </div>
      ) : (
        <p className="mt-4 text-xs text-ink-faint">
          Checked with a quick test call, then encrypted. Never shown again in full.
        </p>
      )}
    </div>
  );
}
