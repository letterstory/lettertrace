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
import { brandNameFromSite, hostOf } from "@/lib/brand-name";
import { cn } from "@/lib/utils";

interface Topic {
  name: string;
  prompts: string[];
}

interface CompetitorDraft {
  name: string;
  /** Comma-separated while editing; split on submit, like the settings form. */
  aliases: string;
  domain: string;
}

type Step = "brand" | "topics" | "searching";

export function Onboarding() {
  const router = useRouter();

  const [step, setStep] = useState<Step>("brand");

  // Step 1: the URL is the only thing we ask for. Everything else on step 2 is
  // read from the site and shown for confirmation.
  const [domain, setDomain] = useState("");

  // Step 2: who the brand is. All editable before confirming.
  const [brandName, setBrandName] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [imageBroken, setImageBroken] = useState(false);

  // Step 2: topics + competitors
  const [topics, setTopics] = useState<Topic[]>([]);
  const [competitors, setCompetitors] = useState<CompetitorDraft[]>([]);
  // Per-block validation, keyed by topic index. Blocks used to be dropped
  // silently when incomplete, so a user could "start monitoring" with three
  // topics on screen and have one saved.
  const [issues, setIssues] = useState<Record<number, "name" | "prompts">>({});
  const [note, setNote] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Step 1 -> suggest -----------------------------------------------------
  // Doubles as the Retry handler: re-submitting is the whole recovery.
  async function handleNext(e?: React.FormEvent) {
    e?.preventDefault();
    if (!domain.trim()) {
      setError("Add your website to continue.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/onboarding/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: domain.trim() }),
      });
      const data = await res.json();

      // Advance only when we actually read the site. This used to run
      // unconditionally, so a 404 or an unreadable page dropped the user onto
      // an empty editor with no idea what had gone wrong — the failure was
      // fetched and then discarded.
      if (!res.ok || !data?.brandName) {
        setError(
          data?.error || "We couldn't read that site. Check the address and try again.",
        );
        return;
      }

      setBrandName(String(data.brandName));
      setDescription(typeof data.description === "string" ? data.description : "");
      setImageUrl(typeof data.imageUrl === "string" ? data.imageUrl : "");
      setImageBroken(false);

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

      // Seeded from the same site read as the topics — no extra call.
      setCompetitors(
        Array.isArray(data?.competitors)
          ? data.competitors
              .map((c: { name?: unknown; aliases?: unknown; domain?: unknown }) => ({
                name: typeof c?.name === "string" ? c.name : "",
                aliases: Array.isArray(c?.aliases)
                  ? c.aliases.filter((a: unknown): a is string => typeof a === "string").join(", ")
                  : "",
                domain: typeof c?.domain === "string" ? c.domain : "",
              }))
              .filter((c: CompetitorDraft) => c.name.trim().length > 0)
          : [],
      );

      if (suggested.length > 0) {
        setTopics(suggested);
        setNote("Here's what we found. Edit anything before you start.");
      } else {
        // We read the site — the identity below is filled in — but no topics
        // came back, so the copy must not claim the read itself failed.
        setTopics([{ name: "", prompts: [""] }]);
        // Each reason names a different fix, so they can't share one line: a
        // spent allowance is fixed in Settings, a slow model by trying again,
        // and everything else only by typing a topic.
        setNote(
          data?.reason === "trial_exhausted"
            ? "Your free credits are used up, so add a key later. For now, add a topic and the questions to monitor."
            : data?.reason === "ai_timeout"
              ? "Your site read fine, but the AI took too long to draft topics. Add one below, or go back and try again in a minute."
              : "We read your site but couldn't draft topics for it. Add a topic and a few questions people ask AI about it.",
        );
      }
      setStep("topics");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // The escape hatch from a site we can't read. Nothing is prefilled except a
  // name derived from the domain, which keeps the required field non-empty so
  // the user isn't blocked at the last step of setup.
  function startManually() {
    setError(null);
    setBrandName(brandNameFromSite({ domain }));
    setDescription("");
    setImageUrl("");
    setTopics([{ name: "", prompts: [""] }]);
    setCompetitors([]);
    setNote("Add a topic and a few questions people ask AI about it.");
    setStep("topics");
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

  function setCompetitorField(i: number, field: keyof CompetitorDraft, value: string) {
    setCompetitors((prev) => prev.map((c, idx) => (idx === i ? { ...c, [field]: value } : c)));
  }
  function removeCompetitor(i: number) {
    setCompetitors((prev) => prev.filter((_, idx) => idx !== i));
  }
  function addCompetitor() {
    setCompetitors((prev) => [...prev, { name: "", aliases: "", domain: "" }]);
  }

  // --- Step 2 -> complete + run ----------------------------------------------
  async function handleStart() {
    const cleaned = topics.map((t) => ({
      name: t.name.trim(),
      // Blank question rows are fine — they're just unused inputs, so drop
      // them. A block is only invalid when it has no filled question at all.
      prompts: t.prompts.map((p) => p.trim()).filter(Boolean),
    }));

    if (!brandName.trim()) {
      setError("Give your brand a name before you start.");
      return;
    }

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
          // Store the host, not the raw paste. Screen 1 is a URL box now, so
          // "https://acme.com/pricing" is ordinary input, and saving it whole
          // showed a full URL with a path back in the Settings domain field.
          brand_domains: hostOf(domain) ? [hostOf(domain)] : [],
          description: description.trim() || null,
          topics: cleaned,
          // Blank rows are just unused inputs, so drop them rather than
          // blocking the submit — a nameless competitor holds nothing else.
          competitors: competitors
            .map((c) => ({
              name: c.name.trim(),
              aliases: c.aliases
                .split(",")
                .map((a) => a.trim())
                .filter(Boolean),
              domain: c.domain.trim() || null,
            }))
            .filter((c) => c.name.length > 0),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || "Something went wrong setting up your project.");
        setStep("topics");
        setBusy(false);
        return;
      }
      // Land on the report the first run just produced — that report IS the
      // thing they signed up to see. The runId has always been returned here
      // and was previously discarded, which sent everyone to the overview.
      // Falls back when no run fired (no key, or the trial allowance is gone):
      // the overview explains that state, a run page for a run that does not
      // exist would not.
      router.push(data?.ran && data?.runId ? `/dashboard/runs/${data.runId}` : "/dashboard");
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
        {/* Deliberately does not name the models: the provider is resolved
            server-side after this screen renders, so anything specific here is
            a guess that goes stale every time the catalog grows. */}
        <p className="mt-2 text-ink-faint">
          We&apos;re asking AI assistants your questions and looking for {brandName || "your brand"}.
          This usually takes a minute or two.
        </p>
        <div className="mt-5">
          {/* Page-level, not inline next to a label, so it carries the wait on
              its own and is sized to be seen. */}
          <Spinner className="h-6 w-6 text-terracotta" />
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
          <h1 className="text-3xl font-semibold text-ink">What&apos;s your website?</h1>
          <p className="mt-2 text-ink-soft">
            That&apos;s all we need. We&apos;ll read your site and set up everything else —
            you just confirm it on the next screen.
          </p>

          <Card className="mt-6">
            <CardBody>
              <form onSubmit={handleNext} className="space-y-5">
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
                      autoFocus
                      required
                    />
                  </div>
                </div>

                {error && (
                  <div className="space-y-2">
                    <p className="text-sm text-terracotta-dark">{error}</p>
                    {/* The site is the thing they can fix, so retrying is the
                        primary move. Setting it up by hand stays available so
                        an unreadable site can never dead-end signup. */}
                    <button
                      type="button"
                      onClick={startManually}
                      className="text-sm font-medium text-ink-soft underline underline-offset-4 transition hover:text-ink"
                    >
                      Or set it up manually
                    </button>
                  </div>
                )}

                <Button type="submit" size="lg" className="w-full" disabled={busy}>
                  {busy ? (
                    <>
                      <Spinner />
                      Reading your site...
                    </>
                  ) : (
                    <>
                      {error ? "Try again" : "Continue"}
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
          <h1 className="text-3xl font-semibold text-ink">Does this look right?</h1>
          {note && <p className="mt-2 text-ink-soft">{note}</p>}

          {/* Identity read from the site. Editable, because a scrape gets the
              name wrong often enough that a read-only summary would be a
              dead end, and brand_name is what every later mention check
              looks for. */}
          <Card className="mt-6">
            <CardBody>
              <div className="flex items-start gap-4">
                {imageUrl && !imageBroken && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imageUrl}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded border border-ink/10 bg-paper object-contain"
                    // Hotlinked from the customer's own domain, so it can 404
                    // or be blocked. Hiding beats a broken-image icon as the
                    // first thing they see of their own brand.
                    onError={() => setImageBroken(true)}
                  />
                )}
                <div className="min-w-0 flex-1 space-y-4">
                  <div>
                    <Label htmlFor="ob-brand">Brand name</Label>
                    <Input
                      id="ob-brand"
                      value={brandName}
                      onChange={(e) => setBrandName(e.target.value)}
                      placeholder="Acme"
                      className="font-medium"
                      required
                    />
                  </div>
                  <div>
                    <Label htmlFor="ob-description">What you do</Label>
                    <Textarea
                      id="ob-description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="What does your brand do?"
                    />
                    <p className="mt-1.5 text-xs text-ink-faint">
                      Used to sharpen your monitoring questions.
                    </p>
                  </div>
                </div>
              </div>
            </CardBody>
          </Card>

          <h2 className="mt-10 text-lg font-semibold text-ink">What should we monitor?</h2>

          <div className="mt-4 space-y-4">
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

          {/* Competitors. Optional by design — share of voice needs them, but
              a user who doesn't know their rivals yet shouldn't be stuck at
              the last step of setup. */}
          <div className="mt-10">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-lg font-semibold text-ink">Who do you compete with?</h2>
              <span className="text-xs text-ink-faint">Optional</span>
            </div>
            <p className="mt-1 text-sm text-ink-soft">
              {competitors.length > 0
                ? "We spotted these. Edit or remove any before you start. We'll track how often each is named alongside you."
                : "Add the brands you want to benchmark against, and we'll track how often each is named alongside you."}
            </p>

            {competitors.length > 0 && (
              // A grid, not a row of flex inputs, so the header labels line up
              // with the columns they name. Aliases and domain are hidden on
              // narrow screens and drop out of the grid flow with them.
              <div className="mt-4">
                <div className="hidden gap-2 pb-1.5 pl-3 sm:grid sm:grid-cols-[15rem_1fr_12rem_2.25rem]">
                  <span className="text-xs font-medium text-ink-faint">Name</span>
                  <span className="text-xs font-medium text-ink-faint">Other names</span>
                  <span className="text-xs font-medium text-ink-faint">Domain</span>
                  <span aria-hidden />
                </div>
                <div className="space-y-2">
                  {competitors.map((c, ci) => (
                    <div
                      key={ci}
                      className="grid grid-cols-[1fr_2.25rem] items-center gap-2 sm:grid-cols-[15rem_1fr_12rem_2.25rem]"
                    >
                      <Input
                        value={c.name}
                        onChange={(e) => setCompetitorField(ci, "name", e.target.value)}
                        placeholder="Competitor name"
                        className="font-medium"
                        aria-label={`Competitor ${ci + 1} name`}
                      />
                      <Input
                        value={c.aliases}
                        onChange={(e) => setCompetitorField(ci, "aliases", e.target.value)}
                        // Short enough not to truncate in this column; a single
                        // name works too, so the comma rule needn't be spelled out.
                        placeholder="Other names"
                        className="hidden text-sm sm:block"
                        aria-label={`Competitor ${ci + 1} aliases`}
                      />
                      <Input
                        value={c.domain}
                        onChange={(e) => setCompetitorField(ci, "domain", e.target.value)}
                        placeholder="domain.com"
                        className="hidden text-sm sm:block"
                        aria-label={`Competitor ${ci + 1} domain`}
                      />
                      <button
                        type="button"
                        onClick={() => removeCompetitor(ci)}
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-ink-faint transition hover:bg-ink/5 hover:text-terracotta-dark"
                        aria-label={`Remove ${c.name.trim() || "competitor"}`}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={addCompetitor}
              className="mt-4 inline-flex items-center gap-1.5 rounded border border-dashed border-ink/20 px-4 py-2.5 text-sm font-medium text-ink-soft transition hover:border-ink/40 hover:bg-ink/[0.02]"
            >
              <Plus className="h-4 w-4" />
              Add competitor
            </button>
          </div>

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
