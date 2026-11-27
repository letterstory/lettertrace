import { ArrowRight, Star } from "lucide-react";

const G2_URL = "https://www.g2.com/search?query=Lettertrace";

function G2Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <circle cx="16" cy="16" r="16" fill="#FF492C" />
      <text
        x="16"
        y="21"
        textAnchor="middle"
        fontFamily="DM Sans, ui-sans-serif, system-ui, sans-serif"
        fontSize="14"
        fontWeight="700"
        fill="#FFFFFF"
      >
        G2
      </text>
    </svg>
  );
}

export function G2Badge() {
  return (
    <section id="g2-rating" className="border-t border-ink/10">
      <div className="mx-auto flex max-w-6xl justify-center px-5 py-10">
        <a
          href={G2_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex items-center gap-4 rounded border border-ink/10 bg-surface px-5 py-3.5 shadow-lift transition hover:border-ink/30"
        >
          <G2Mark className="h-9 w-9 shrink-0" />
          <span className="flex flex-col items-start gap-0.5 text-left">
            <span className="mono-eyebrow">reviewed on G2</span>
            <span className="flex items-center gap-1.5 text-sm text-ink">
              <Star className="h-3.5 w-3.5 fill-current text-terracotta" aria-hidden />
              See how users rate Lettertrace
            </span>
          </span>
          <span className="ml-2 hidden items-center gap-1.5 font-mono text-xs text-ink-soft transition group-hover:text-ink sm:inline-flex">
            read reviews
            <ArrowRight className="h-3.5 w-3.5 text-terracotta-dark transition group-hover:translate-x-0.5" />
          </span>
        </a>
      </div>
    </section>
  );
}
