import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme";

// Shared chrome for the public legal pages (/privacy, /terms). Kept separate
// from the marketing page's nav so these stay readable and link-stable — they
// get cited from Google's OAuth consent screen and from client contracts.

export function LegalPage({
  title,
  updated,
  intro,
  children,
}: {
  title: string;
  updated: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-paper">
      <header className="border-b border-ink/10">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-5">
          <Link href="/" className="inline-flex items-center gap-2">
            <Logo />
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link
              href="/"
              className="inline-flex items-center gap-1 text-sm text-ink-faint transition hover:text-ink"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden /> Back
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-14">
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mt-3 text-sm text-ink-faint">Last updated {updated}</p>
        <p className="mt-6 text-base leading-relaxed text-ink-soft">{intro}</p>

        <div className="mt-12 space-y-10">{children}</div>

        <div className="mt-16 border-t border-ink/10 pt-8 text-sm text-ink-faint">
          <p>
            Lettertrace is operated by The Letter Company.{" "}
            <Link href="/privacy" className="text-terracotta-dark hover:text-terracotta">
              Privacy Policy
            </Link>{" "}
            ·{" "}
            <Link href="/terms" className="text-terracotta-dark hover:text-terracotta">
              Terms of Service
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}

export function Section({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={`s${n}`} className="scroll-mt-8">
      <h2 className="font-serif text-2xl font-semibold text-ink">
        <span className="mr-2 text-ink-faint/70">{n}.</span>
        {title}
      </h2>
      <div className="mt-4 space-y-4 text-base leading-relaxed text-ink-soft [&_a]:text-terracotta-dark [&_a:hover]:text-terracotta [&_code]:rounded [&_code]:bg-ink/5 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-sm [&_li]:leading-relaxed [&_strong]:font-semibold [&_strong]:text-ink [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6">
        {children}
      </div>
    </section>
  );
}
