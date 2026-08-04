"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Badge, Button, Input, Spinner } from "@/components/ui";
import { cn, formatDate } from "@/lib/utils";
import { PROVIDERS } from "@/lib/models";
import { ROUTER_LIST, routerProviders, type RouterInfo } from "@/lib/routers";
import type { Provider, RouterId, RouterKeyPublic } from "@/lib/types";

// One card per router, mirroring the provider-key cards. The difference is what
// a connected card has to say: a router key that works is not the same as a
// router key that can measure, so the card reports per-engine what this
// credential was actually observed to do rather than a bare "Connected".

// Each tile's background is the exact color baked into its PNG (sampled from
// the corner pixel), so the object-contain letterboxing is invisible. Merge's
// art is dark-on-white, hence the light tile with a hairline border to keep it
// from dissolving into a light page.
const ROUTER_LOGO: Record<RouterId, { src: string; tileClass: string }> = {
  concentrate: { src: "/routers/concentrate.png", tileClass: "bg-[#0d0e10]" },
  openrouter: { src: "/routers/openrouter.png", tileClass: "bg-[#04080a]" },
  merge: { src: "/routers/merge.png", tileClass: "border border-ink/10 bg-white" },
};

/** One engine's verdict on a saved credential, as returned by the save call. */
interface Check {
  provider: Provider;
  reachable: boolean;
  search: "passthrough" | "none";
  searchWorks: boolean | null;
  error?: string;
}

export default function RoutersManager({ keys }: { keys: RouterKeyPublic[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {ROUTER_LIST.map((info) => (
        <RouterCard
          key={info.id}
          info={info}
          existing={keys.find((k) => k.router === info.id) ?? null}
        />
      ))}
    </div>
  );
}

function RouterCard({
  info,
  existing,
}: {
  info: RouterInfo;
  existing: RouterKeyPublic | null;
}) {
  const router = useRouter();
  const logo = ROUTER_LOGO[info.id];

  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);

  const showForm = !existing || editing;
  const served = routerProviders(info.id);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim() || verifying) return;
    setError(null);
    setChecks(null);
    setVerifying(true);
    try {
      const res = await fetch("/api/router-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ router: info.id, apiKey }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || "Something went wrong. Please try again.");
        return;
      }
      setApiKey("");
      setReveal(false);
      setEditing(false);
      // Kept until the next save: the outcome of the grounding checks is the
      // most useful thing on the card and it isn't recoverable from a refresh.
      setChecks((data?.checks as Check[] | undefined) ?? null);
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
      const res = await fetch(`/api/router-keys/${existing.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error || "Could not remove that key.");
        return;
      }
      setChecks(null);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="flex flex-col rounded border border-ink/10 bg-paper p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={cn("h-11 w-11 shrink-0 overflow-hidden rounded", logo.tileClass)}
            aria-hidden
          >
            <img src={logo.src} alt="" className="h-full w-full object-contain p-1" />
          </span>
          <div>
            <p className="font-serif text-lg font-semibold leading-tight text-ink">
              {info.label}
            </p>
            <p className="text-xs text-ink-faint">{info.blurb}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
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

      <div className="mt-4 flex-1 space-y-3">
        {existing && !editing && (
          <>
            <div className="flex items-center justify-between gap-3 rounded border border-ink/10 bg-paper-shade/50 px-4 py-3">
              <p className="font-mono text-sm text-ink">{existing.key_hint}</p>
              <p className="shrink-0 text-xs text-ink-faint">
                Added {formatDate(existing.created_at)}
              </p>
            </div>
            <EngineStatus
              routerId={info.id}
              served={served}
              searchVerified={existing.search_verified ?? []}
              checks={checks}
            />
          </>
        )}

        {showForm && (
          <form onSubmit={handleSave} className="space-y-3">
            <div className="relative">
              <Input
                type={reveal ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={info.keyPrefix ? `${info.keyPrefix}...` : "API key"}
                autoComplete="off"
                spellCheck={false}
                aria-label={`${info.label} API key`}
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
                loadingText="Checking engines…"
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
            {/* Says what the wait is for. Saving a router key takes longer than
                saving a provider key because it runs a real web search per
                engine, and an unexplained 15 seconds reads as a hang. */}
            <p className="text-xs text-ink-faint">
              Saving runs one small call per engine, plus a real web search, to check what
              this key can measure. Takes a few seconds.
            </p>
          </form>
        )}

        {error && <p className="text-sm text-terracotta-dark">{error}</p>}
      </div>

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
          Checked against each engine, then encrypted. Never shown again in full.
        </p>
      )}
    </div>
  );
}

/**
 * Per-engine status for a connected router.
 *
 * The three states a user needs to tell apart: this engine is measurable with
 * live-web grounding, it is reachable but only for ungrounded answers, or the
 * router doesn't serve it at all. Collapsing them into "connected" is what would
 * let someone chart a memory answer as a search-grounded one.
 */
function EngineStatus({
  routerId,
  served,
  searchVerified,
  checks,
}: {
  routerId: RouterId;
  served: Provider[];
  searchVerified: Provider[];
  checks: Check[] | null;
}) {
  return (
    <div className="space-y-2">
      <ul className="space-y-1.5">
        {served.map((provider) => {
          const check = checks?.find((c) => c.provider === provider);
          const grounded = searchVerified.includes(provider);
          const unreachable = check ? !check.reachable : false;

          return (
            <li key={provider} className="flex items-start gap-2 text-xs">
              {unreachable ? (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-terracotta-dark" />
              ) : grounded ? (
                <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-mint-ink" />
              ) : (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-butter-ink" />
              )}
              <span className="text-ink-soft">
                <span className="font-medium text-ink">{PROVIDERS[provider].label}</span>{" "}
                {unreachable
                  ? `not reachable on this key${check?.error ? ` — ${check.error}` : ""}`
                  : grounded
                    ? "measurable, live web search confirmed"
                    : "reachable, but web search isn't confirmed — usable only for projects with web search off"}
              </span>
            </li>
          );
        })}
      </ul>
      {/* Engines the router serves are listed above; the ones it doesn't are
          worth naming once, because "my router does 400 models" makes their
          absence surprising. */}
      <p className="text-xs text-ink-faint">
        Gemini, Google AI Overviews and Perplexity need their own keys — their answers
        aren&apos;t comparable when routed through a gateway.
      </p>
    </div>
  );
}
