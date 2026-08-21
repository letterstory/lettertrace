import Link from "next/link";
import {
  ArrowRight,
  CalendarCheck,
  Github,
  KeyRound,
  Layers,
  LineChart,
  MessageSquareText,
  Radar,
  ShieldCheck,
  Sparkles,
  Swords,
  Timer,
} from "lucide-react";
import { Badge, Button, Card } from "@/components/ui";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme";
import { InstallCli } from "@/components/install-cli";
import {
  FOUNDER_CALL_LANDING_SOURCE,
  founderCallUrl,
  taggedBookingUrl,
} from "@/lib/founder-call";

const GITHUB_URL = "https://github.com/letterstory/lettertrace";

// ------------------------------------------------------------------
// Small presentational helpers (local to the landing page)
// ------------------------------------------------------------------

function TerminalDots() {
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-3 w-3 rounded-sm bg-[#FF5F57]" />
      <span className="h-3 w-3 rounded-sm bg-[#FEBC2E]" />
      <span className="h-3 w-3 rounded-sm bg-[#28C840]" />
    </div>
  );
}

function Terminal() {
  return (
    <div className="overflow-hidden rounded border border-ink/10 bg-terminal text-terminal-ink shadow-lift">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <TerminalDots />
        <span className="font-mono text-[11px] text-white/40">lettertrace · monitor</span>
        <span className="w-10" />
      </div>
      <div className="space-y-1.5 p-5 font-mono text-[13px] leading-relaxed">
        <p>
          <span className="text-mint-bright">$</span> lettertrace run{" "}
          <span className="text-white/50">--project acme</span>
        </p>
        <p className="text-white/45">› querying claude-opus-4-8 across 24 prompts…</p>
        <p>
          <span className="text-mint-bright">✓</span> acme mentioned in{" "}
          <span className="text-sand">15 / 24</span> answers
        </p>
        <p>
          <span className="text-white/45">share of voice</span>{" "}
          <span className="text-sand">████████░░░░░░░░</span>{" "}
          <span className="text-white">41%</span>
        </p>
        <p>
          <span className="text-white/45">sentiment</span>{" "}
          <span className="text-mint-bright">+0.34 positive</span>
        </p>
        <p>
          <span className="text-white/45">top competitor</span> notion{" "}
          <span className="text-teal">· 28%</span>
        </p>
        <p className="pt-1 text-white/40">
          <span className="text-mint-bright">$</span>{" "}
          <span className="inline-block h-4 w-2 translate-y-0.5 animate-blink bg-terminal-ink/80" />
        </p>
      </div>
    </div>
  );
}

const STEPS = [
  {
    n: "01",
    title: "Track your topics",
    body: "Add the subjects your buyers ask about, “best CRM for startups”, “email tools for agencies”.",
    icon: MessageSquareText,
  },
  {
    n: "02",
    title: "Auto-generate variations",
    body: "Lettertrace writes the real questions people put to AI assistants, so you monitor how they’re actually answered.",
    icon: Sparkles,
  },
  {
    n: "03",
    title: "Trends over time",
    body: "Every run is a datapoint. Watch visibility, prominence, and sentiment move week over week.",
    icon: LineChart,
  },
  {
    n: "04",
    title: "Benchmark competitors",
    body: "Ingest rival brands and see your share of voice, who the models recommend, and how often.",
    icon: Swords,
  },
];

const FEATURES = [
  {
    title: "Bring your own key",
    body: "Use your own Anthropic, OpenAI & Google keys. They’re encrypted at rest and never leave your infrastructure.",
    icon: KeyRound,
    tone: "terracotta" as const,
  },
  {
    title: "Multi-model",
    body: "Monitor Claude, ChatGPT, Gemini, and Google AI Overviews side by side. Add more answer engines as they matter.",
    icon: Layers,
    tone: "teal" as const,
  },
  {
    title: "Variation generation",
    body: "Turn one topic into dozens of natural prompts automatically, no manual prompt-writing.",
    icon: Sparkles,
    tone: "sand" as const,
  },
  {
    title: "Sentiment & recommendations",
    body: "Know not just if you appear, but whether the answer speaks well of you, and recommends you.",
    icon: Radar,
    tone: "mint" as const,
  },
  {
    title: "Share of voice",
    body: "See exactly how often you win the answer versus each competitor you track.",
    icon: Swords,
    tone: "butter" as const,
  },
  {
    title: "Scheduled monitoring",
    body: "Run daily or weekly on autopilot and build a trend line you can act on.",
    icon: Timer,
    tone: "terracotta" as const,
  },
];

const toneBg: Record<string, string> = {
  terracotta: "bg-terracotta/12 text-terracotta-dark",
  teal: "bg-teal/20 text-teal-dark",
  sand: "bg-sand-tint text-ink-soft",
  mint: "bg-mint-tint text-mint-ink",
  butter: "bg-butter-tint text-butter-ink",
};

export default function LandingPage() {
  // Gated on the same env var as the dashboard's founder-call offer, and for
  // the same reason (see lib/founder-call.ts): a self-hosted Lettertrace must
  // not send its visitors to *our* founder's calendar. Unset means the section
  // does not exist.
  const bookingUrl = founderCallUrl();

  return (
    <div id="top" className="min-h-screen bg-paper text-ink">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-ink/10 bg-paper/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <a href="#top" aria-label="Back to top" className="w-fit">
            <Logo />
          </a>
          <nav className="hidden items-center gap-8 text-sm text-ink-soft md:flex">
            <a href="#how" className="transition hover:text-ink">How it works</a>
            <a href="#features" className="transition hover:text-ink">Features</a>
            <a href="#open-source" className="transition hover:text-ink">Open source</a>
          </nav>
          <div className="flex items-center gap-2">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Lettertrace on GitHub"
              title="Lettertrace on GitHub"
              className="inline-flex h-9 w-9 items-center justify-center rounded border border-ink/15 text-ink-soft transition hover:border-ink/35 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40"
            >
              <Github className="h-4 w-4" aria-hidden />
            </a>
            <ThemeToggle />
            <div className="hidden items-center gap-2 sm:flex">
              <Button href="/login" variant="ghost" size="sm">Sign in</Button>
              <Button href="/login" size="sm">Initialize</Button>
            </div>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden bg-grid">
        <div className="pointer-events-none absolute -left-24 top-10 h-72 w-72 rounded bg-terracotta/50 glow-blob" />
        <div className="pointer-events-none absolute right-0 top-40 h-72 w-72 rounded bg-mint glow-blob" />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 lg:grid-cols-2 lg:py-28">
          <div className="animate-fade-up">
            <Badge tone="terracotta">
              <span className="font-mono text-[11px]">open-source · bring-your-own-key</span>
            </Badge>
            <h1 className="mt-5 text-5xl font-semibold leading-[1.05] tracking-tight text-ink sm:text-6xl">
              Track your AI visibility, <em className="italic">for free</em>.
            </h1>
            <p className="mt-5 max-w-xl text-lg text-ink-soft">
              Lettertrace measures how often Claude, ChatGPT, and Gemini mention your
              company. But there&apos;s a catch: it&apos;s free end-to-end, developer-first, and open source.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button href="/login" size="lg">
                Start monitoring: it&apos;s free
                <ArrowRight className="h-4 w-4" />
              </Button>
              <InstallCli />
            </div>
            <p className="mt-4 font-mono text-xs text-ink-faint">
              works with ChatGPT, Claude &amp; Gemini · self-host in minutes
            </p>
          </div>

          <div className="animate-fade-up lg:pl-6">
            <Terminal />
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="mx-auto max-w-6xl px-5 py-20">
        <div className="max-w-2xl">
          <p className="mono-eyebrow">how it works</p>
          <h2 className="mt-3 text-3xl font-semibold text-ink sm:text-4xl">
            From a topic to a trend line, automatically.
          </h2>
        </div>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step) => {
            const Icon = step.icon;
            return (
              <Card key={step.n} className="p-6">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm text-ink-faint">{step.n}</span>
                  <span className="flex h-9 w-9 items-center justify-center rounded bg-ink/[0.04] text-terracotta-dark">
                    <Icon className="h-5 w-5" />
                  </span>
                </div>
                <h3 className="mt-4 text-lg font-semibold text-ink">{step.title}</h3>
                <p className="mt-2 text-sm text-ink-faint">{step.body}</p>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Metrics preview band */}
      <section className="border-y border-ink/10 bg-paper-shade/50">
        <div className="mx-auto max-w-6xl px-5 py-20">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <p className="mono-eyebrow">the numbers that matter</p>
              <h2 className="mt-3 text-3xl font-semibold text-ink sm:text-4xl">
                A data-rich visibility report.
              </h2>
              <p className="mt-4 text-ink-soft">
                Lettertrace turns raw AI answers into the metrics AEO/GEO teams track: visibility,
                share of voice, prominence, and sentiment, per topic, per model, over time.
              </p>
              <div className="mt-6 grid grid-cols-2 gap-3">
                <PreviewStat label="Brand visibility" value="62%" dot="bg-terracotta" />
                <PreviewStat label="Share of voice" value="41%" dot="bg-mint-bright" />
                <PreviewStat label="Sentiment" value="+0.34" dot="bg-sand" />
                <PreviewStat label="Competitors" value="5" dot="bg-teal" />
              </div>
            </div>

            {/* Faux answer + share-of-voice card */}
            <Card className="p-6">
              <p className="mono-eyebrow">sample answer · claude</p>
              <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                “For fast-growing startups, a few tools stand out. <Mark>Acme</Mark> is a strong
                pick for teams that want automation without losing their brand voice, while Notion
                and Linear are popular for docs and issue tracking…”
              </p>
              <div className="mt-6 space-y-3">
                <ShareRow name="Acme" pct={41} brand />
                <ShareRow name="Notion" pct={28} />
                <ShareRow name="Linear" pct={19} />
                <ShareRow name="Others" pct={12} />
              </div>
            </Card>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl px-5 py-20">
        <div className="max-w-2xl">
          <p className="mono-eyebrow">features</p>
          <h2 className="mt-3 text-3xl font-semibold text-ink sm:text-4xl">
            Everything you need to diagnose AI mentions.
          </h2>
        </div>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <Card key={f.title} className="p-6">
                <span
                  className={`flex h-10 w-10 items-center justify-center rounded ${toneBg[f.tone]}`}
                >
                  <Icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-lg font-semibold text-ink">{f.title}</h3>
                <p className="mt-2 text-sm text-ink-faint">{f.body}</p>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Open source */}
      <section id="open-source" className="border-t border-ink/10 bg-paper-shade/50">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 lg:grid-cols-2">
          <div>
            <p className="mono-eyebrow">open source</p>
            <h2 className="mt-3 text-3xl font-semibold text-ink sm:text-4xl">
              Yours to run, inspect, and extend.
            </h2>
            <ul className="mt-6 space-y-3 text-ink-soft">
              <OSPoint icon={ShieldCheck}>MIT licensed, fork it, self-host it, make it yours.</OSPoint>
              <OSPoint icon={KeyRound}>Bring your own keys. No usage markup, no middleman.</OSPoint>
              <OSPoint icon={Layers}>Your data lives in your own Supabase, no vendor lock-in.</OSPoint>
            </ul>
          </div>
          <div className="overflow-hidden rounded border border-ink/10 bg-terminal text-terminal-ink shadow-lift">
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <TerminalDots />
              <span className="ml-2 font-mono text-[11px] text-white/40">self-host</span>
            </div>
            <div className="space-y-1.5 p-5 font-mono text-[13px] leading-relaxed">
              <p><span className="text-mint-bright">$</span> git clone lettertrace &amp;&amp; cd lettertrace</p>
              <p><span className="text-mint-bright">$</span> npm install</p>
              <p><span className="text-mint-bright">$</span> cp .env.example .env.local</p>
              <p className="text-white/45"># add Supabase URL + keys</p>
              <p><span className="text-mint-bright">$</span> npm run dev</p>
              <p className="text-sand">→ http://localhost:3000</p>
            </div>
          </div>
        </div>
      </section>

      {/* Founder call */}
      {bookingUrl && (
        <section className="mx-auto max-w-6xl px-5 pt-20">
          <div className="relative overflow-hidden rounded border border-ink/10 bg-surface shadow-lift">
            <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded bg-mint glow-blob" />
            <div className="pointer-events-none absolute -bottom-24 -left-16 h-56 w-56 rounded bg-terracotta/40 glow-blob" />
            <div className="relative flex flex-col gap-8 p-8 sm:p-10 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-start gap-4">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded bg-ink/[0.04] text-terracotta-dark">
                  <CalendarCheck className="h-5 w-5" aria-hidden />
                </span>
                <div>
                  <p className="mono-eyebrow">talk to a human</p>
                  <h2 className="mt-2 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
                    Grab 15 minutes with Mathew.
                  </h2>
                  <p className="mt-2 max-w-lg text-ink-soft">
                    Our founder will walk you through setting up your brand and topics,
                    and how to read your first results.
                  </p>
                </div>
              </div>
              <a
                href={taggedBookingUrl(bookingUrl, FOUNDER_CALL_LANDING_SOURCE)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-12 shrink-0 items-center justify-center gap-2 self-center rounded bg-ink px-7 text-base font-medium tracking-tight text-paper shadow-sm transition-colors hover:bg-ink/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper lg:ml-6"
              >
                Pick a time
                <ArrowRight className="h-4 w-4" aria-hidden />
              </a>
            </div>
          </div>
        </section>
      )}

      {/* Final CTA */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute left-1/2 top-0 h-64 w-[36rem] -translate-x-1/2 rounded bg-terracotta/50 glow-blob" />
        <div className="relative mx-auto max-w-3xl px-5 py-24 text-center">
          <h2 className="text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            Find out what AI says about you.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-lg text-ink-soft">
            Set up your brand, add a key, and run your first monitor in minutes.
          </p>
          <div className="mt-8 flex justify-center">
            <Button href="/login" size="lg">
              Start monitoring, free
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-ink/10">
        <div className="mx-auto grid max-w-6xl gap-8 px-5 py-12 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-1">
            <Logo />
            <p className="mt-3 max-w-xs text-sm text-ink-faint">
              Open-source monitoring for how your brand shows up in AI assistant answers.
            </p>
          </div>
          <FooterCol
            title="Product"
            links={[
              { label: "How it works", href: "#how" },
              { label: "Features", href: "#features" },
              { label: "Open source", href: "#open-source" },
            ]}
          />
          <FooterCol
            title="Open source"
            links={[
              { label: "GitHub", href: GITHUB_URL },
              { label: "MIT License", href: GITHUB_URL },
              { label: "Self-host guide", href: GITHUB_URL },
            ]}
          />
          <FooterCol
            title="Company"
            links={[
              { label: "Privacy Policy", href: "/privacy" },
              { label: "Terms of Service", href: "/terms" },
              { label: "Contact", href: "mailto:support@letterbrace.com" },
            ]}
          />
        </div>
        <div className="border-t border-ink/10">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-5 py-5 text-xs text-ink-faint">
            <span>© 2026 Made by the Letter Company</span>
            <span className="font-mono">built for AEO / GEO teams</span>
          </div>
        </div>
      </footer>

      {/* Product Hunt badge */}
      <a
        href="https://www.producthunt.com/products/lettertrace?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-lettertrace-2"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Lettertrace on Product Hunt"
        className="fixed bottom-5 right-5 z-50 transition hover:opacity-90"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt="Lettertrace - Track your AI visibility for free (using your own API keys!) | Product Hunt"
          width={210}
          height={45}
          src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1218357&theme=light&t=1786538146874"
          className="rounded shadow-lift"
        />
      </a>
    </div>
  );
}

// --- tiny local components ---------------------------------------

function Mark({ children }: { children: React.ReactNode }) {
  // butter is a light amber in both themes, so the highlight text stays dark.
  return <mark className="rounded-sm bg-butter px-1 text-[#1A1917]">{children}</mark>;
}

function PreviewStat({ label, value, dot }: { label: string; value: string; dot: string }) {
  return (
    <div className="rounded border border-ink/10 bg-surface p-4">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-sm ${dot}`} />
        <span className="text-xs font-medium text-ink-faint">{label}</span>
      </div>
      <p className="mt-1.5 font-serif text-2xl font-semibold text-ink">{value}</p>
    </div>
  );
}

function ShareRow({ name, pct, brand = false }: { name: string; pct: number; brand?: boolean }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-16 shrink-0 truncate text-ink-soft">{name}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-sm bg-ink/[0.06]">
        <div
          className={`h-full rounded-sm ${brand ? "bg-terracotta" : "bg-teal"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-9 shrink-0 text-right font-medium text-ink-soft">{pct}%</span>
    </div>
  );
}

function OSPoint({ icon: Icon, children }: { icon: typeof ShieldCheck; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded bg-mint-tint text-mint-ink">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="text-sm">{children}</span>
    </li>
  );
}

function FooterCol({
  title,
  links,
}: {
  title: string;
  links: { label: string; href: string }[];
}) {
  return (
    <div>
      <p className="text-sm font-semibold text-ink">{title}</p>
      <ul className="mt-3 space-y-2">
        {links.map((l) => (
          <li key={l.label}>
            <Link href={l.href} className="text-sm text-ink-faint transition hover:text-ink">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
