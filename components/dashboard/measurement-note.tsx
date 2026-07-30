import Link from "next/link";
import { Info, TriangleAlert } from "lucide-react";
import { measurementVerdict } from "@/lib/metrics";
import { cn } from "@/lib/utils";

// Why a 0% can mean two completely different things, said out loud.
//
// A run reports "0% brand visibility" identically whether the models were asked
// what to use and picked someone else, or were asked how to do something and
// recommended nobody at all. Only the first is a finding. The second means the
// prompts didn't measure anything, and reading it as a competitive loss is
// simply wrong.
//
// The distinguishing number already existed — computeMeasurementQuality's
// informativeRate — but it was computed and never shown, so the two cases were
// indistinguishable in the UI. Observed live: one brand sat at 0% with 70% of
// answers naming its tracked competitors (a real authority gap) while another
// sat at 0% with 16%.
//
// Note what informativeRate actually counts: answers naming a company WE TRACK,
// not answers naming any company. Checking the low case showed its answers were
// full of vendors (Kore.ai, Boomi, Airia) that simply weren't on its competitor
// list, each appearing once — a mismatched list in an immature category, not
// prompts that failed to ask for recommendations. So the low-rate copy must not
// blame the prompts, which an earlier draft of it did.

export function MeasurementNote({
  totalResponses,
  responsesNamingSomeone,
  informativeRate,
  brandMentioned,
  competitorsTracked,
}: {
  totalResponses: number;
  responsesNamingSomeone: number;
  informativeRate: number;
  /** Did the brand appear in any answer this run? */
  brandMentioned: boolean;
  competitorsTracked: number;
}) {
  const verdict = measurementVerdict({
    totalResponses,
    informativeRate,
    brandMentioned,
    competitorsTracked,
  });
  if (verdict === "no-data") return null;

  const named = `${responsesNamingSomeone} of ${totalResponses} answer${
    totalResponses === 1 ? "" : "s"
  }`;

  if (verdict === "no-competitors") {
    return (
      <Note tone="info">
        No competitors tracked yet, so a run can only tell you whether you were
        named, not who was named instead.{" "}
        <NoteLink href="/dashboard/competitors">Add competitors</NoteLink> to see who
        the models reach for in your category.
      </Note>
    );
  }

  if (verdict === "thin-sample") {
    return (
      <Note tone="warn">
        Only {named} named a company you track, so there is little here to compare
        against. Usually that means the models are naming companies missing from
        your{" "}
        <NoteLink href="/dashboard/competitors">competitor list</NoteLink>, or that
        this category has no settled set of vendors yet. It can also mean your{" "}
        <NoteLink href="/dashboard/topics">prompts</NoteLink> aren&apos;t asking for
        recommendations.
        {!brandMentioned && " Either way, read this 0% as not-yet-measured rather than as a loss."}
      </Note>
    );
  }

  if (verdict === "real-gap") {
    return (
      <Note tone="warn">
        {named} named a company you track, and none named you. The models are
        recommending in your category and not reaching for you yet, so this is a
        real visibility gap rather than a problem with the prompts.
      </Note>
    );
  }

  return (
    <Note tone="info">
      {named} named a company you track. The rest recommended nobody, so they
      can&apos;t move your visibility either way.
    </Note>
  );
}

function Note({ tone, children }: { tone: "info" | "warn"; children: React.ReactNode }) {
  const warn = tone === "warn";
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded border px-4 py-3",
        warn
          ? "border-terracotta/30 bg-terracotta/[0.06]"
          : "border-ink/10 bg-paper-shade/50",
      )}
    >
      <span className={cn("mt-0.5 shrink-0", warn ? "text-terracotta-dark" : "text-ink-faint")}>
        {warn ? <TriangleAlert className="h-4 w-4" /> : <Info className="h-4 w-4" />}
      </span>
      <p className="text-sm text-ink-soft">{children}</p>
    </div>
  );
}

function NoteLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="font-medium text-terracotta-dark underline underline-offset-2 transition-colors hover:text-terracotta"
    >
      {children}
    </Link>
  );
}
