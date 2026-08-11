import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------
// Landing-page social proof: a single marquee row of review cards.
//
// ⚠️ MOCK COPY — the reviews below are written placeholders standing in for
// the real Product Hunt / customer quotes. Swap `REVIEWS` wholesale (names,
// roles, and bodies) once the real ones land; nothing else needs to change.
//
// Layout follows what actually converts for a launch-stage page: a small
// aggregate line, then individually readable reviews a visitor can stop and
// read — hover or keyboard focus pauses the drift — rather than a slideshow
// nobody clicks through. Sits directly above the final CTA, where social
// proof does the most work.
// ------------------------------------------------------------------

type Review = {
  name: string;
  /** Avatar-tile glyph, normally the reviewer's initials. */
  initials: string;
  role: string;
  stars: 4 | 5;
  body: string;
  tone: keyof typeof toneTile;
};

const toneTile = {
  terracotta: "bg-terracotta/12 text-terracotta-dark",
  teal: "bg-teal/15 text-teal-dark",
  mint: "bg-mint-tint text-mint-ink",
  butter: "bg-butter-tint text-butter-ink",
  sand: "bg-sand-tint text-ink-soft",
} as const;

const REVIEWS: Review[] = [
  {
    name: "Dana R.",
    initials: "DR",
    role: "Head of growth · B2B SaaS",
    stars: 5,
    tone: "terracotta",
    body:
      "Went in assuming I'd hit a “talk to sales” wall inside five minutes, because that's exactly what happened with the last two AEO tools I tried. It never came. Pointed it at my own Anthropic key, added six topics, had a first run back in under ten minutes. Three weeks in and the only thing I've changed is adding a competitor. The bring-your-own-key part is why I'm still here — I moved one project from Claude to Gemini just to see whether the answers diverged, and it cost nothing extra on Lettertrace's end, because they aren't in the billing path at all.",
  },
  {
    name: "Priya N.",
    initials: "PN",
    role: "Content lead · Series A fintech",
    stars: 4,
    tone: "teal",
    body:
      "Someone dropped this in our growth channel. I track four topics and get a weekly run telling me whether we're in the answer or not. That's the whole use case. Took about two minutes. I'd like Perplexity in the mix eventually, but it already replaced a spreadsheet I hated maintaining.",
  },
  {
    name: "Tom W.",
    initials: "TW",
    role: "Founder · dev tools",
    stars: 5,
    tone: "mint",
    body:
      "Share of voice against our three named competitors was the one number I couldn't get anywhere else without signing a $2k/mo contract. Ran it, got it, screenshotted it into the board deck the same afternoon.",
  },
  {
    name: "Alex K.",
    initials: "AK",
    role: "Staff engineer · marketplace",
    stars: 4,
    tone: "butter",
    body:
      "Almost skipped it. I already script my own eval runs against the raw APIs and figured a wrapper wouldn't add much. What got me was the variation generation — one topic becomes twenty questions that actually sound like what a person types, and I was never going to hand-write those every week. Reading the source before signing up didn't hurt either. Only real gripe: CSV export doesn't break out per-model columns yet.",
  },
  {
    name: "Sofia M.",
    initials: "SM",
    role: "Platform engineer · healthtech",
    stars: 5,
    tone: "sand",
    body:
      "Self-hosted onto our own Supabase in an afternoon. Clone, env vars, deploy. Our data never leaves our infrastructure, which is the only reason legal signed off on any of this.",
  },
  {
    name: "Ben A.",
    initials: "BA",
    role: "VP marketing · B2B SaaS",
    stars: 5,
    tone: "terracotta",
    body:
      "Being mentioned and being recommended are not the same thing, and this is the first tool I've used that tells them apart. Turned out we showed up in about 60% of answers and got hedged in most of them. That one distinction changed everything we published last quarter.",
  },
  {
    name: "Marcus O.",
    initials: "MO",
    role: "SEO lead · agency",
    stars: 4,
    tone: "teal",
    body:
      "The trend line is the actual product. One run is a curiosity; eight weekly runs is a chart I can walk into a planning meeting with. Setup took longer than the 60 seconds I'd assumed — closer to ten minutes once you count keys and topics — but it has run itself ever since.",
  },
  {
    name: "Elena V.",
    initials: "EV",
    role: "Solo founder",
    stars: 5,
    tone: "mint",
    body:
      "Total spend so far is whatever the model calls cost me, which is somewhere around $3. I kept waiting for the free tier to reveal itself as a trial. It hasn't.",
  },
];

const AVERAGE = REVIEWS.reduce((sum, r) => sum + r.stars, 0) / REVIEWS.length;

function Stars({ n }: { n: number }) {
  return (
    <span className="flex items-center gap-0.5" aria-label={`${n} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          aria-hidden
          className={cn(
            "h-3.5 w-3.5",
            i < n ? "fill-terracotta text-terracotta" : "fill-ink/10 text-ink/10",
          )}
        />
      ))}
    </span>
  );
}

function ReviewCard({ review }: { review: Review }) {
  return (
    <figure className="flex w-[19rem] shrink-0 flex-col rounded border border-ink/10 bg-surface p-5 shadow-card transition hover:border-ink/25 hover:shadow-lift sm:w-[22rem]">
      <Stars n={review.stars} />
      <blockquote className="mt-3 flex-1 text-sm leading-relaxed text-ink-soft">
        {review.body}
      </blockquote>
      <figcaption className="mt-5 flex items-center gap-3 border-t border-ink/[0.07] pt-4">
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded font-mono text-[11px] font-medium",
            toneTile[review.tone],
          )}
          aria-hidden
        >
          {review.initials}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-ink">{review.name}</span>
          <span className="block truncate text-xs text-ink-faint">{review.role}</span>
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * The drifting row.
 *
 * The cards are rendered twice: the first copy is the real content, the second
 * is `aria-hidden` scenery whose only job is to be under the viewport edge at
 * the moment the track snaps back, so a screen reader hears eight reviews
 * rather than sixteen.
 *
 * Motion stops on hover *and* on focus-within — a keyboard user tabbing into a
 * card must not have it slide out from under them — and stops entirely under
 * `prefers-reduced-motion`, where the row degrades to an ordinary horizontally
 * scrollable strip.
 */
function MarqueeRow({ items, duration }: { items: Review[]; duration: string }) {
  return (
    <div className="group flex overflow-x-auto pb-2 [-ms-overflow-style:none] [scrollbar-width:none] motion-safe:overflow-hidden [&::-webkit-scrollbar]:hidden">
      {/* No gap on the track itself, and a trailing `pr-5` on each half. That
          makes one half exactly (n cards + n gaps) wide, so -50% lands the
          duplicate precisely where the original began. Putting the gap on the
          track instead leaves the seam half a gap short, and the row visibly
          hitches once per loop. */}
      <div
        className={cn(
          "flex w-max motion-safe:animate-marquee",
          "motion-safe:group-hover:[animation-play-state:paused]",
          "motion-safe:group-focus-within:[animation-play-state:paused]",
        )}
        style={{ animationDuration: duration }}
      >
        <div className="flex gap-5 pr-5">
          {items.map((r) => (
            <ReviewCard key={r.name} review={r} />
          ))}
        </div>
        <div className="flex gap-5 pr-5" aria-hidden>
          {items.map((r) => (
            <ReviewCard key={`${r.name}-dup`} review={r} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function Reviews() {
  return (
    // Plain paper, not the `paper-shade` band used above it — the open-source
    // section is already shaded, and two shaded bands in a row read as one.
    <section id="reviews" className="border-t border-ink/10 bg-paper py-20">
      <div className="mx-auto max-w-6xl px-5">
        <div className="max-w-2xl">
          <p className="mono-eyebrow">reviews</p>
          <h2 className="mt-3 text-3xl font-semibold text-ink sm:text-4xl">
            Teams who stopped guessing.
          </h2>
          <p className="mt-4 text-ink-soft">
            Marketers, founders, and engineers using Lettertrace to see how AI assistants
            answer questions about them.
          </p>
        </div>

        <div className="mt-7 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Stars n={Math.round(AVERAGE)} />
          <p className="text-sm text-ink-soft">
            <span className="font-serif text-lg font-semibold text-ink">
              {AVERAGE.toFixed(1)}
            </span>{" "}
            average across {REVIEWS.length} reviews
          </p>
        </div>
      </div>

      {/* Full-bleed and edge-masked, so cards dissolve at the viewport rather
          than being guillotined by a container edge. The mask lives on this
          wrapper, not the row: a mask on the animated element travels with the
          transform, and the fade would drift off-screen along with it. */}
      <div className="mt-10 [mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]">
        <MarqueeRow items={REVIEWS} duration="100s" />
      </div>
    </section>
  );
}
