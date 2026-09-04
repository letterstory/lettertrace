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
    const suggestion = await suggestFromSite({
      provider: key.provider,
      model: key.model,
      apiKey: key.apiKey,
      brandName,
      siteText: scrape.text,
    });
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
