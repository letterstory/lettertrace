"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, ExternalLink } from "lucide-react";
import { Button, Input, Select, Label, Spinner } from "@/components/ui";
import { PROVIDERS, PROVIDER_LIST } from "@/lib/models";
import type { Provider, ProviderKeyPublic } from "@/lib/types";

export default function KeysManager({ keys }: { keys: ProviderKeyPublic[] }) {
  const router = useRouter();

  const [provider, setProvider] = useState<Provider>(PROVIDER_LIST[0].id);
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const info = PROVIDERS[provider];

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setVerifying(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey, label }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || "Something went wrong. Please try again.");
        return;
      }
      setApiKey("");
      setLabel("");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleRemove(id: string) {
    setRemovingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error || "Could not remove that key.");
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
    <div className="space-y-6">
      {keys.length > 0 ? (
        <ul className="divide-y divide-ink/10 rounded-2xl border border-ink/10">
          {keys.map((k) => (
            <li
              key={k.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">
                  {PROVIDERS[k.provider]?.label ?? k.provider}
                  {k.label && (
                    <span className="ml-2 text-ink-faint">· {k.label}</span>
                  )}
                </p>
                <p className="font-mono text-xs text-ink-faint">{k.key_hint}</p>
              </div>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => handleRemove(k.id)}
                disabled={removingId === k.id}
              >
                {removingId === k.id ? (
                  <Spinner />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-faint">
          No keys yet. Add one below to start monitoring.
        </p>
      )}

      <form
        onSubmit={handleAdd}
        className="space-y-4 rounded-2xl border border-dashed border-ink/15 bg-paper-shade/40 p-5"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="key-provider">Provider</Label>
            <Select
              id="key-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value as Provider)}
            >
              {PROVIDER_LIST.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="key-label">Label (optional)</Label>
            <Input
              id="key-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Work account"
            />
          </div>
        </div>

        <div>
          <Label htmlFor="key-value">API key</Label>
          <Input
            id="key-value"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={`${info.keyPrefix}...`}
            autoComplete="off"
          />
          <p className="mt-1.5 text-xs text-ink-faint">
            <a
              href={info.keyUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-terracotta-dark hover:text-terracotta"
            >
              Get a key <ExternalLink className="h-3 w-3" />
            </a>
          </p>
        </div>

        {error && <p className="text-sm text-terracotta">{error}</p>}

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={verifying || apiKey.trim().length === 0}>
            {verifying && <Spinner />}
            {verifying ? "Verifying key..." : "Add & verify"}
          </Button>
        </div>
      </form>
    </div>
  );
}
