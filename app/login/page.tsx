import { Sparkles, Users, TrendingUp } from "lucide-react";
import { Card, CardBody } from "@/components/ui";
import { Logo } from "@/components/logo";
import { AuthForm } from "./auth-form";

export const dynamic = "force-dynamic";

const bullets = [
  {
    icon: Sparkles,
    title: "Bring your own key",
    body: "Run prompts against ChatGPT or Claude with your own API key, no middleman.",
  },
  {
    icon: Users,
    title: "Track competitors",
    body: "See who else gets named alongside your brand, and how often.",
  },
  {
    icon: TrendingUp,
    title: "Watch the trends",
    body: "Follow mention rate and share-of-voice over time as models change.",
  },
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string; mode?: string; error?: string };
}) {
  const next = typeof searchParams.next === "string" ? searchParams.next : undefined;
  const mode = typeof searchParams.mode === "string" ? searchParams.mode : undefined;
  // Set by /auth/callback when a provider hand-off or code exchange fails.
  const error = typeof searchParams.error === "string" ? searchParams.error : undefined;

  return (
    <main className="flex min-h-screen bg-paper">
      {/* Left: branded panel */}
      <aside className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-paper-shade px-12 py-14 lg:flex">
        <div
          className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-butter/50 blur-3xl"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute -bottom-24 -left-16 h-80 w-80 rounded-full bg-mint/40 blur-3xl"
          aria-hidden
        />

        <div className="relative">
          <Logo />
        </div>

        <div className="relative max-w-md">
          <h1 className="font-serif text-4xl font-semibold leading-tight text-ink">
            Monitor your brand across AI answers.
          </h1>
          <p className="mt-4 text-base text-ink-soft">
            Lettertrace watches how often you, and your competitors, show up when people ask
            AI assistants for recommendations.
          </p>

          <ul className="mt-10 space-y-5">
            {bullets.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-3.5">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-terracotta/12 text-terracotta-dark">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                <div>
                  <p className="font-medium text-ink">{title}</p>
                  <p className="mt-0.5 text-sm text-ink-faint">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-ink-faint">
          Open-source. Your keys stay yours.
        </p>
      </aside>

      {/* Right: auth form */}
      <div className="flex w-full flex-col items-center justify-center px-6 py-12 lg:w-1/2">
        <div className="w-full max-w-md">
          <div className="mb-8 flex justify-center lg:hidden">
            <Logo />
          </div>
          <Card>
            <CardBody className="p-8 sm:p-10">
              <AuthForm next={next} mode={mode} initialError={error} />
            </CardBody>
          </Card>
        </div>
      </div>
    </main>
  );
}
