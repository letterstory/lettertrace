import { Button } from "@/components/ui";
import { Logo } from "@/components/logo";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-paper bg-dotted px-6 text-center">
      <Logo />
      <div>
        <p className="font-serif text-6xl font-semibold text-terracotta">404</p>
        <h1 className="mt-2 text-2xl font-semibold text-ink">This trace went cold.</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-ink-faint">
          We couldn&apos;t find that page. It may have moved, or never existed.
        </p>
      </div>
      <div className="flex gap-3">
        <Button href="/">Back home</Button>
        <Button href="/dashboard" variant="secondary">
          Go to dashboard
        </Button>
      </div>
    </main>
  );
}
