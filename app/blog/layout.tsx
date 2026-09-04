import Link from "next/link";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme";
import { Button } from "@/components/ui";
import AccessBeacon from "@/components/access-beacon";
import { isAccessReportingConfigured } from "@/lib/owned-access";

// Shared chrome for lettertrace.com/blog. Kept separate from the marketing
// page's nav so the reading surface stays clean. The AccessBeacon only mounts
// when owned-access reporting is configured, so /blog on a fork / self-hosted
// deployment ships no telemetry.
export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-paper">
      <header className="border-b border-ink/10">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-5">
          <Link href="/blog" className="inline-flex items-center gap-2" aria-label="Lettertrace blog">
            <Logo />
          </Link>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Button href="/dashboard" size="sm">
              Trace your brand
            </Button>
          </div>
        </div>
      </header>

      <main>{children}</main>

      <footer className="border-t border-ink/10">
        <div className="mx-auto flex max-w-3xl flex-col gap-2 px-5 py-8 text-sm text-ink-faint sm:flex-row sm:items-center sm:justify-between">
          <p>Lettertrace is operated by The Letter Company.</p>
          <p className="flex gap-3">
            <Link href="/" className="transition hover:text-ink">
              Home
            </Link>
            <Link href="/privacy" className="transition hover:text-ink">
              Privacy
            </Link>
            <Link href="/terms" className="transition hover:text-ink">
              Terms
            </Link>
          </p>
        </div>
      </footer>

      {isAccessReportingConfigured() ? <AccessBeacon /> : null}
    </div>
  );
}
