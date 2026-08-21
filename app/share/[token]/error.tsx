"use client";

import { Button } from "@/components/ui";
import { Logo } from "@/components/logo";

// Error boundary scoped to /share/[token]. Distinct from the branded
// not-found.tsx: that one means "this token is bad/expired", this one means
// "something is wrong with the deployment itself" (today, in practice, an
// unset SUPABASE_SERVICE_ROLE_KEY -- see lib/supabase/service.ts and
// lib/share-links.ts's mint-time check). Blaming the deployment rather than
// the link matters here: without this boundary Next's generic default error
// page renders instead, telling a recipient nothing and the sharer nothing.
export default function ShareError() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-paper bg-dotted px-6 text-center">
      <Logo />
      <div>
        <h1 className="text-2xl font-semibold text-ink">This link isn&apos;t available right now.</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-ink-faint">
          The report couldn&apos;t be loaded. This is a problem with the site, not
          with your link — try again later.
        </p>
      </div>
      <Button href="/">Back home</Button>
    </main>
  );
}
