import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { scrapeDomain } from "@/lib/scrape";
import { brandNameFromSite } from "@/lib/brand-name";
import { suggestFromSite, humanError } from "@/lib/llm";
import {
  resolveKey,
  recordTrialUsage,
  recordTrialSpend,
  pickDefaultProvider,
} from "@/lib/trial";
import { spendMicros } from "@/lib/pricing";
import { logDashboard } from "@/lib/activity";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// The model gets less than the route does, on purpose. googleFetch alone may
// spend ~330s on one call (GOOGLE_MAX_ATTEMPTS 4 x GOOGLE_TIMEOUT_MS 60s, plus
// a GOOGLE_RETRY_BUDGET_MS 90s sleep budget) because those constants are sized
// for the run route's 300s — this route has 60s. Measured 2026-09-04: a
// stripe.com suggest call took 136919ms end to end while Gemini was congested,
// which in production is killed at 60s and returns NOTHING.
//
// That last part is what this guards. Identity comes from the page's own
// metadata and had already arrived in ~1s; letting a slow model take the whole
// request down costs the user their name, description and icon for no reason.
// The same 60s-vs-330s mismatch exists in the other suggestion routes, but they
// have no identity to lose and simply report a retryable error.
const SUGGEST_DEADLINE_MS = 35_000;

/** Resolves to null if `work` outruns `ms`. The losing call is abandoned rather
 *  than aborted — its signal isn't ours to cancel — so any tokens it goes on to
 *  spend are not metered. Accepted deliberately: the deadline sits far enough
 *  inside the route budget that this is the rare case, and the alternative is
 *  threading an AbortSignal through every adapter for one caller. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// POST /api/onboarding/suggest { domain }
// Reads the site and returns everything screen 2 needs: who the brand is (name,
// description, icon) and what to monitor (topics with questions, competitors).
// Always returns 200 except 401/400; the wizard reads `reason` to decide what
// to show.
//
// `brandName` is optional and is normally derived here rather than typed —
// screen 1 asks for a URL and nothing else. A caller may still pass one (the
// user editing it and asking for a re-read), and theirs wins.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const givenName = typeof body.brandName === "string" ? body.brandName.trim() : "";
  const domain = typeof body.domain === "string" ? body.domain.trim() : "";
  if (!domain) {
    return NextResponse.json({ error: "Add your website so we can read it." }, { status: 400 });
  }

  const scrape = await scrapeDomain(domain);

  // The scrape is checked BEFORE the key, and the order matters now: identity
  // comes from the page's own metadata and needs no model at all, so a user
  // whose free credits are gone still gets their name, description and icon
  // filled in. Reporting "no key" for a site we could not read would also point
  // them at Settings when the thing they can actually fix is the URL.
  if (!scrape.ok || !scrape.text) {
    return NextResponse.json({
      scraped: false,
      brandName: "",
      description: "",
      imageUrl: "",
      topics: [],
      competitors: [],
      reason: "scrape_failed",
      error: scrape.error,
    });
  }

  const brandName =
    givenName || brandNameFromSite({ siteName: scrape.siteName, title: scrape.title, domain });
  const identity = {
    brandName,
    description: scrape.description ?? "",
    imageUrl: scrape.imageUrl ?? "",
    title: scrape.title ?? "",
  };

  const key = await resolveKey(supabase, user.id, pickDefaultProvider());
  if (!key.apiKey) {
    return NextResponse.json({
      ...identity,
      scraped: false,
      topics: [],
      competitors: [],
      reason: key.source === "exhausted" ? "trial_exhausted" : "no_key",
    });
  }

  try {
    const suggestion = await withDeadline(
      suggestFromSite({
        provider: key.provider,
        model: key.model,
        apiKey: key.apiKey,
        brandName,
        siteText: scrape.text,
      }),
      SUGGEST_DEADLINE_MS,
    );
    if (!suggestion) {
      return NextResponse.json({
        ...identity,
        scraped: false,
        topics: [],
        competitors: [],
        reason: "ai_timeout",
      });
    }
    // Metered even though no free RUN is consumed: these endpoints spend the
    // operator's key, so without this a script could call them forever.
    if (key.source === "trial") {
      await recordTrialUsage(supabase, suggestion.tokens);
      await recordTrialSpend(
        supabase,
        spendMicros({ provider: key.provider, model: key.model, tokens: suggestion.tokens }),
      );
    }
    await logDashboard(user, request, {
      category: "onboarding",
      action: "onboarding.suggested",
      summary: `Analyzed ${domain} as "${brandName}" and suggested ${suggestion.topics.length} topic${suggestion.topics.length === 1 ? "" : "s"} and ${suggestion.competitors.length} competitor${suggestion.competitors.length === 1 ? "" : "s"} with AI`,
      metadata: {
        topics: suggestion.topics.length,
        competitors: suggestion.competitors.length,
        tokens: suggestion.tokens,
        keySource: key.source,
        domain,
        brandName,
      },
    });
    return NextResponse.json({
      ...identity,
      scraped: suggestion.topics.length > 0,
      // The model read the whole page and writes a better sentence than the
      // meta description, which is often ad copy — but the meta description is
      // there when the model returns nothing.
      description: suggestion.description || identity.description,
      topics: suggestion.topics,
      competitors: suggestion.competitors,
    });
  } catch (e) {
    return NextResponse.json({
      ...identity,
      scraped: false,
      topics: [],
      competitors: [],
      reason: "ai_failed",
      error: humanError(e),
    });
  }
}
