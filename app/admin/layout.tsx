import type { ReactNode } from "react";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme";
import { AdminNav } from "./nav";

/**
 * A deliberately plain shell, separate from the dashboard's.
 *
 * The dashboard layout loads projects, trial state and an unseen-run banner —
 * all of which are properties of the signed-in account, and none of which mean
 * anything here. Worse, an operations page that renders inside the product's
 * own chrome invites reading it as part of the product; it is not, and nothing
 * on it is scoped to one account.
 *
 * No nav link points here from anywhere. The route is reached by typing it,
 * which is the correct amount of discoverability for a page most signed-in
 * users would get a 404 from.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-paper">
      <header className="border-b border-ink/10">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <Logo />
            <AdminNav />
          </div>
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="text-sm text-ink-faint hover:text-ink">
              Dashboard
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}
