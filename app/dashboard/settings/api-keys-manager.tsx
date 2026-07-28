"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Plus, Trash2 } from "lucide-react";
import { Button, Input, Spinner } from "@/components/ui";
import { formatDate } from "@/lib/utils";
import type { ApiKeyPublic } from "@/lib/types";

// Lettertrace API keys for programmatic access (REST v1 + MCP). The plaintext
// is shown exactly once, right after creation.

export default function ApiKeysManager({ keys }: { keys: ApiKeyPublic[] }) {
  const router = useRouter();

  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (creating) return;
    setError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || "Something went wrong. Please try again.");
        return;
      }
      setFreshKey(data.apiKey);
      setCopied(false);
      setName("");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRemove(id: string) {
    if (removingId) return;
    setError(null);
    setRemovingId(id);
    try {
      const res = await fetch(`/api/api-keys/${id}`, { method: "DELETE" });
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

  async function handleCopy() {
    if (!freshKey) return;
    try {
      await navigator.clipboard.writeText(freshKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable; the key is still visible to select */
    }
  }

  return (
    <div className="space-y-4">
      {/* One-time reveal of a freshly created key */}
      {freshKey && (
        <div className="rounded border border-emerald-700/20 bg-mint/30 p-4">
          <p className="text-sm font-medium text-ink">
            Copy your new key now — it won&apos;t be shown again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-paper px-3 py-2 font-mono text-sm text-ink">
              {freshKey}
            </code>
            <Button type="button" size="sm" variant="secondary" onClick={handleCopy}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}

      {/* Existing keys */}
      {keys.length > 0 && (
        <ul className="divide-y divide-ink/10 rounded border border-ink/10 bg-paper">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{k.name}</p>
                <p className="font-mono text-xs text-ink-faint">
                  {k.key_hint}
                  <span className="ml-2 font-sans">
                    Created {formatDate(k.created_at)}
                    {k.last_used_at
                      ? ` · Last used ${formatDate(k.last_used_at)}`
                      : " · Never used"}
                  </span>
                </p>
              </div>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => handleRemove(k.id)}
                disabled={removingId === k.id}
              >
                {removingId === k.id ? <Spinner /> : <Trash2 className="h-3.5 w-3.5" />}
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Create form */}
      <form onSubmit={handleCreate} className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Key name, e.g. “Claude Code”"
          aria-label="API key name"
          className="max-w-xs"
        />
        <Button type="submit" size="sm" disabled={creating}>
          {creating ? <Spinner /> : <Plus className="h-3.5 w-3.5" />}
          Create key
        </Button>
      </form>

      {error && <p className="text-sm text-terracotta-dark">{error}</p>}
    </div>
  );
}
