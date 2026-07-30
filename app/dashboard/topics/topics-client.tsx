"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Prompt, Topic } from "@/lib/types";
import {
  Button,
  Card,
  CardBody,
  Badge,
  Label,
  Input,
  Select,
  Spinner,
} from "@/components/ui";
import { Plus, Sparkles, Trash2, X } from "lucide-react";
import { NeedsKeyNotice } from "@/components/dashboard/needs-key-notice";
import { article } from "@/lib/utils";

interface Props {
  topics: Topic[];
  prompts: Prompt[];
  hasKey: boolean;
  providerLabel: string;
}

export function TopicsClient({ topics, prompts, hasKey, providerLabel }: Props) {
  const router = useRouter();

  // --- Add topic form state ---
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function handleCreateTopic(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null }),
      });
      const body = await res.json();
      if (!res.ok) {
        setCreateError(body?.error ?? "Could not create topic.");
        return;
      }
      setName("");
      setDescription("");
      router.refresh();
    } catch {
      setCreateError("Something went wrong. Try again.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Add topic */}
      <Card>
        <CardBody>
          <form onSubmit={handleCreateTopic} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="topic-name">Topic name</Label>
                <Input
                  id="topic-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. project management software"
                  maxLength={120}
                />
              </div>
              <div>
                <Label htmlFor="topic-desc">Description (optional)</Label>
                <Input
                  id="topic-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="A little context to steer the questions"
                  maxLength={300}
                />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Button
                type="submit"
                loading={creating}
                loadingText="Adding…"
                disabled={!name.trim()}
              >
                <Plus className="h-4 w-4" /> Add topic
              </Button>
              {createError && <p className="text-sm text-terracotta-dark">{createError}</p>}
            </div>
          </form>
        </CardBody>
      </Card>

      {/* No key notice */}
      {!hasKey && (
        <NeedsKeyNotice providerLabel={providerLabel} action="auto-generate variations" />
      )}

      {/* Topics list */}
      {topics.length === 0 ? (
        <p className="px-1 text-sm text-ink-faint">
          No topics yet. Add your first topic above to start tracking a subject.
        </p>
      ) : (
        <div className="space-y-6">
          {topics.map((topic) => (
            <TopicCard
              key={topic.id}
              topic={topic}
              prompts={prompts.filter((p) => p.topic_id === topic.id)}
              hasKey={hasKey}
              providerLabel={providerLabel}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TopicCard({
  topic,
  prompts,
  hasKey,
  providerLabel,
}: {
  topic: Topic;
  prompts: Prompt[];
  hasKey: boolean;
  providerLabel: string;
}) {
  const router = useRouter();

  const [count, setCount] = useState("8");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const [manualText, setManualText] = useState("");
  const [addingManual, setAddingManual] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  const [deletingTopic, setDeletingTopic] = useState(false);

  const activeCount = prompts.filter((p) => p.is_active).length;

  async function handleGenerate() {
    setGenerating(true);
    setGenError(null);
    try {
      const res = await fetch(`/api/topics/${topic.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: Number(count) }),
      });
      const body = await res.json();
      if (!res.ok) {
        setGenError(body?.error ?? "Could not generate variations.");
        return;
      }
      router.refresh();
    } catch {
      setGenError("Something went wrong generating variations.");
    } finally {
      setGenerating(false);
    }
  }

  async function handleAddManual(e: React.FormEvent) {
    e.preventDefault();
    if (!manualText.trim()) return;
    setAddingManual(true);
    setManualError(null);
    try {
      const res = await fetch("/api/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic_id: topic.id, text: manualText.trim() }),
      });
      const body = await res.json();
      if (!res.ok) {
        setManualError(body?.error ?? "Could not add prompt.");
        return;
      }
      setManualText("");
      router.refresh();
    } catch {
      setManualError("Something went wrong. Try again.");
    } finally {
      setAddingManual(false);
    }
  }

  async function handleDeleteTopic() {
    if (!window.confirm(`Delete “${topic.name}” and all of its prompts?`)) return;
    setDeletingTopic(true);
    try {
      const res = await fetch(`/api/topics/${topic.id}`, { method: "DELETE" });
      if (res.ok) router.refresh();
      else setDeletingTopic(false);
    } catch {
      setDeletingTopic(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-5">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-ink">{topic.name}</h3>
            {topic.description && (
              <p className="mt-1 text-sm text-ink-soft">{topic.description}</p>
            )}
            <p className="mt-2 text-xs text-ink-faint">
              {prompts.length} {prompts.length === 1 ? "prompt" : "prompts"}
              {prompts.length > 0 && ` · ${activeCount} active`}
            </p>
          </div>
          <Button
            variant="danger"
            size="sm"
            onClick={handleDeleteTopic}
            disabled={deletingTopic}
          >
            {deletingTopic ? <Spinner /> : <Trash2 className="h-4 w-4" />}
            Delete
          </Button>
        </div>

        {/* Generate + manual controls */}
        <div className="grid gap-4 rounded border border-ink/10 bg-paper-shade/40 p-4 md:grid-cols-2">
          {/* Generate variations */}
          <div className="space-y-2">
            <Label>Generate variations</Label>
            <div className="flex items-center gap-2">
              <Select
                aria-label="Number of variations"
                value={count}
                onChange={(e) => setCount(e.target.value)}
                disabled={generating}
                className="w-24"
              >
                <option value="5">5</option>
                <option value="8">8</option>
                <option value="12">12</option>
              </Select>
              <Button
                onClick={handleGenerate}
                disabled={!hasKey || generating}
                // A disabled button explains nothing on hover, and hovering it
                // is exactly what someone does before giving up.
                title={!hasKey ? `Add ${article(providerLabel)} ${providerLabel} key in Settings to enable` : undefined}
              >
                {generating ? <Spinner /> : <Sparkles className="h-4 w-4" />}
                {generating ? "Generating…" : "Generate"}
              </Button>
            </div>
            {genError && <p className="text-sm text-terracotta-dark">{genError}</p>}
            {!hasKey && (
              <NeedsKeyNotice
                compact
                providerLabel={providerLabel}
                action="generate variations"
              />
            )}
          </div>

          {/* Add your own */}
          <div className="space-y-2">
            <Label htmlFor={`manual-${topic.id}`}>Add your own</Label>
            <form onSubmit={handleAddManual} className="flex items-center gap-2">
              <Input
                id={`manual-${topic.id}`}
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                placeholder="Type a question a person might ask…"
                maxLength={500}
                disabled={addingManual}
              />
              <Button type="submit" variant="ghost" disabled={addingManual || !manualText.trim()}>
                {addingManual ? <Spinner /> : <Plus className="h-4 w-4" />}
                Add
              </Button>
            </form>
            {manualError && <p className="text-sm text-terracotta-dark">{manualError}</p>}
          </div>
        </div>

        {/* Prompts list */}
        {prompts.length > 0 && (
          <ul className="divide-y divide-ink/[0.07]">
            {prompts.map((prompt) => (
              <PromptRow key={prompt.id} prompt={prompt} />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function PromptRow({ prompt }: { prompt: Prompt }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function toggleActive() {
    setBusy(true);
    try {
      const res = await fetch(`/api/prompts/${prompt.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !prompt.is_active }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/prompts/${prompt.id}`, { method: "DELETE" });
      if (res.ok) router.refresh();
      else setDeleting(false);
    } catch {
      setDeleting(false);
    }
  }

  return (
    <li className="flex items-start gap-3 py-3">
      <input
        type="checkbox"
        checked={prompt.is_active}
        onChange={toggleActive}
        disabled={busy}
        aria-label={prompt.is_active ? "Deactivate prompt" : "Activate prompt"}
        className="mt-1 h-4 w-4 shrink-0 cursor-pointer rounded-sm border-ink/30 text-terracotta-dark accent-terracotta focus:ring-terracotta/40"
      />
      <div className="min-w-0 flex-1">
        <p className={prompt.is_active ? "text-sm text-ink" : "text-sm text-ink-faint line-through"}>
          {prompt.text}
        </p>
        <div className="mt-1">
          <Badge tone={prompt.source === "ai" ? "teal" : "butter"}>
            {prompt.source === "ai" ? "AI" : "Manual"}
          </Badge>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleDelete}
        disabled={deleting}
        aria-label="Delete prompt"
        className="shrink-0"
      >
        {deleting ? <Spinner /> : <X className="h-4 w-4" />}
      </Button>
    </li>
  );
}
