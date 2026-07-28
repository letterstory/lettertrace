"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ArrowLeft,
  Check,
  Globe,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { Badge, Button, Card, CardBody, Input, Label, Spinner, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";

interface Topic {
  name: string;
  prompts: string[];
}

type Step = "brand" | "topics" | "searching";

export function Onboarding() {
  const router = useRouter();

  const [step, setStep] = useState<Step>("brand");

  // Step 1: brand & project
  const [brandName, setBrandName] = useState("");
  const [domain, setDomain] = useState("");
  const [description, setDescription] = useState("");

  // Step 2: topics
  const [topics, setTopics] = useState<Topic[]>([]);
  // Per-block validation, keyed by topic index. Blocks used to be dropped
  // silently when incomplete, so a user could "start monitoring" with three
  // topics on screen and have one saved.
  const [issues, setIssues] = useState<Record<number, "name" | "prompts">>({});
  const [note, setNote] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Step 1 -> suggest -----------------------------------------------------
  async function handleNext(e: React.FormEvent) {
    e.preventDefault();
    if (!brandName.trim()) {
      setError("Tell us your brand name to continue.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/onboarding/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandName: brandName.trim(), domain: domain.trim() }),
      });
      const data = await res.json();

      const suggested: Topic[] = Array.isArray(data?.topics)
        ? data.topics
            .map((t: { name?: unknown; prompts?: unknown }) => ({
              name: typeof t?.name === "string" ? t.name : "",
              prompts: Array.isArray(t?.prompts)
                ? t.prompts.filter((p: unknown): p is string => typeof p === "string")
                : [],
            }))
            .filter((t: Topic) => t.name && t.prompts.length)
        : [];

      if (data?.description && !description.trim()) {
        setDescription(String(data.description));
      }

      if (suggested.length > 0) {
        setTopics(suggested);
        setNote(`We read ${domain.trim() || "your site"} and drafted these. Edit anything before you start.`);
      } else {
        setTopics([{ name: "", prompts: [""] }]);
        setNote(
          data?.reason === "trial_exhausted"
            ? "Your free credits are used up, so add a key later. For now, add a topic and the questions to monitor."
            : "We couldn't read your site automatically. Add a topic and a few questions people ask AI about it.",
        );
      }
      setStep("topics");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // --- Step 2 editing --------------------------------------------------------
  function setTopicName(i: number, name: string) {
    setTopics((prev) => prev.map((t, idx) => (idx === i ? { ...t, name } : t)));
  }
  function removePrompt(ti: number, pi: number) {
    setTopics((prev) =>
      prev.map((t, idx) => (idx === ti ? { ...t, prompts: t.prompts.filter((_, j) => j !== pi) } : t)),
    );
  }
  function setPrompt(ti: number, pi: number, value: string) {
    setTopics((prev) =>
      prev.map((t, idx) =>
        idx === ti ? { ...t, prompts: t.prompts.map((p, j) => (j === pi ? value : p)) } : t,
      ),
    );
  }
  function addPrompt(ti: number) {
    setTopics((prev) =>
      prev.map((t, idx) => (idx === ti ? { ...t, prompts: [...t.prompts, ""] } : t)),
    );
  }
  function removeTopic(ti: number) {
    setTopics((prev) => prev.filter((_, idx) => idx !== ti));
  }
  function addTopic() {
    setTopics((prev) => [...prev, { name: "", prompts: [""] }]);
  }

  // --- Step 2 -> complete + run ----------------------------------------------
  async function handleStart() {
    const cleaned = topics.map((t) => ({
      name: t.name.trim(),
      // Blank question rows are fine — they're just unused inputs, so drop
      // them. A block is only invalid when it has no filled question at all.
      prompts: t.prompts.map((p) => p.trim()).filter(Boolean),
    }));

    if (cleaned.length === 0) {
      setError("Add at least one topic with a question before you start.");
      return;
    }

    // Flag every incomplete block rather than discarding it. Missing name is
    // reported first so a block with neither shows the topmost problem.
    const found: Record<number, "name" | "prompts"> = {};
    cleaned.forEach((t, i) => {
      if (!t.name) found[i] = "name";
      else if (t.prompts.length === 0) found[i] = "prompts";
    });

    if (Object.keys(found).length > 0) {
      setIssues(found);
      const n = Object.keys(found).length;
      setError(
        n === 1
          ? "One topic is incomplete. Every topic needs a name and at least one question."
          : `${n} topics are incomplete. Every topic needs a name and at least one question.`,
      );
      return;
    }

    setIssues({});
    setError(null);
    setBusy(true);
    setStep("searching");
    try {
      const res = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand_name: brandName.trim(),
          name: brandName.trim(),
          brand_domains: domain.trim() ? [domain.trim()] : [],
          description: description.trim() || null,
          topics: cleaned,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || "Something went wrong setting up your project.");
        setStep("topics");
        setBusy(false);
        return;
      }
      // The org (and, ideally, its first run) now exist and it's the active
      // one. Land on the overview whether we came from first-run onboarding
      // or from "New organization".
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Network error while starting your first search.");
      setStep("topics");
      setBusy(false);
    }
  }

  // --- Render ----------------------------------------------------------------
  if (step === "searching") {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center text-center">
        <div className="relative flex h-16 w-16 items-center justify-center">
          <span className="absolute inset-0 animate-ping rounded bg-terracotta/20" />
          <span className="flex h-16 w-16 items-center justify-center rounded bg-terracotta/10 text-terracotta">
            <Sparkles className="h-7 w-7" />
          </span>
        </div>
        <h2 className="mt-6 text-2xl font-semibold text-ink">Running your first search</h2>
        <p className="mt-2 text-ink-faint">
          We&apos;re asking ChatGPT and Claude your questions and looking for {brandName || "your brand"}.
          This takes about a minute.
        </p>
        <div className="mt-5">
          <Spinner className="text-terracotta" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl py-6">
      <div className="mb-6 flex items-center gap-2">
        <StepDot active={step === "brand"} done={step === "topics"} label="1" />
        <span className="h-px w-8 bg-ink/15" />
        <StepDot active={step === "topics"} done={false} label="2" />
      </div>

      {step === "brand" && (
        <div>
          <h1 className="text-3xl font-semibold text-ink">Set up your brand</h1>
          <p className="mt-2 text-ink-soft">
            Let&apos;s start with your brand. We&apos;ll scan your website and predict what AI search
            queries to look out for.
          </p>

          <Card className="mt-6">
            <CardBody>
              <form onSubmit={handleNext} className="space-y-5">
                <div>
                  <Label htmlFor="ob-brand">Brand name</Label>
                  <Input
                    id="ob-brand"
                    value={brandName}
                    onChange={(e) => setBrandName(e.target.value)}
                    placeholder="Acme"
                    autoFocus
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="ob-domain">Website</Label>
                  <div className="relative">
                    <Globe className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
                    <Input
                      id="ob-domain"
                      value={domain}
                      onChange={(e) => setDomain(e.target.value)}
                      placeholder="acme.com"
                      className="pl-9"
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-ink-faint">
                    We read this to figure out what you do and draft your monitoring topics.
                  </p>
                </div>

                {error && <p className="text-sm text-terracotta-dark">{error}</p>}

                <Button type="submit" size="lg" className="w-full" disabled={busy}>
                  {busy ? (
                    <>
                      <Spinner />
                      Scanning your site...
                    </>
                  ) : (
                    <>
                      Next
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </Button>
              </form>
            </CardBody>
          </Card>
        </div>
      )}

      {step === "topics" && (
        <div>
          <h1 className="text-3xl font-semibold text-ink">What should we monitor?</h1>
          {note && <p className="mt-2 text-ink-soft">{note}</p>}

          <div className="mt-6 space-y-4">
            {topics.map((topic, ti) => (
              <Card key={ti}>
                <CardBody className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Input
                      value={topic.name}
                      onChange={(e) => {
                        setTopicName(ti, e.target.value);
                        if (issues[ti]) setIssues((m) => ({ ...m, [ti]: undefined! }));
                      }}
                      placeholder="Topic (e.g. project management software)"
                      aria-invalid={issues[ti] === "name" || undefined}
                      className={cn(
                        "font-medium",
                        issues[ti] === "name" && "border-terracotta focus:border-terracotta",
                      )}
                    />
                    <button
                      type="button"
                      onClick={() => removeTopic(ti)}
                      className="shrink-0 rounded p-2 text-ink-faint transition hover:bg-ink/5 hover:text-terracotta-dark"
                      aria-label="Remove topic"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="space-y-2">
                    {topic.prompts.map((prompt, pi) => (
                      <div key={pi} className="flex items-center gap-2">
                        <span className="text-ink-faint">
                          <Sparkles className="h-3.5 w-3.5" />
                        </span>
                        <Input
                          value={prompt}
                          onChange={(e) => {
                            setPrompt(ti, pi, e.target.value);
                            if (issues[ti]) setIssues((m) => ({ ...m, [ti]: undefined! }));
                          }}
                          placeholder="A question someone asks an AI assistant"
                          aria-invalid={issues[ti] === "prompts" || undefined}
                          className={cn(
                            "text-sm",
                            issues[ti] === "prompts" && "border-terracotta focus:border-terracotta",
                          )}
                        />
                        <button
                          type="button"
                          onClick={() => removePrompt(ti, pi)}
                          className="shrink-0 rounded p-2 text-ink-faint transition hover:bg-ink/5"
                          aria-label="Remove question"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => addPrompt(ti)}
                      className="inline-flex items-center gap-1 text-sm font-medium text-terracotta-dark transition hover:text-terracotta"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add question
                    </button>
                  </div>
                  {issues[ti] && (
                    <p className="text-sm text-terracotta-dark">
                      {issues[ti] === "name"
                        ? "Give this topic a name, or remove it."
                        : "Add at least one question, or remove this topic."}
                    </p>
                  )}
                </CardBody>
              </Card>
            ))}
          </div>

          <button
            type="button"
            onClick={addTopic}
            className="mt-4 inline-flex items-center gap-1.5 rounded border border-dashed border-ink/20 px-4 py-2.5 text-sm font-medium text-ink-soft transition hover:border-ink/40 hover:bg-ink/[0.02]"
          >
            <Plus className="h-4 w-4" />
            Add topic
          </button>

          {error && <p className="mt-4 text-sm text-terracotta-dark">{error}</p>}

          <div className="mt-6 flex items-center justify-between gap-3">
            <Button variant="ghost" onClick={() => setStep("brand")} disabled={busy}>
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
            <Button size="lg" onClick={handleStart} disabled={busy}>
              <Check className="h-4 w-4" />
              Start monitoring
            </Button>
          </div>
          <p className="mt-3 text-center text-xs text-ink-faint">
            We&apos;ll run your first search right away, on the house.
          </p>
        </div>
      )}
    </div>
  );
}

function StepDot({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <span
      className={
        "flex h-7 w-7 items-center justify-center rounded text-xs font-semibold " +
        (done
          ? "bg-terracotta text-paper"
          : active
            ? "bg-terracotta/15 text-terracotta-dark ring-1 ring-terracotta/30"
            : "bg-ink/[0.06] text-ink-faint")
      }
    >
      {done ? <Check className="h-3.5 w-3.5" /> : label}
    </span>
  );
}
