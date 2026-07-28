import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { scrapeDomain } from "@/lib/scrape";
import { suggestFromSite, humanError } from "@/lib/llm";
import { resolveKey, recordTrialUsage, pickDefaultProvider } from "@/lib/trial";
import { logDashboard } from "@/lib/activity";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// POST /api/onboarding/suggest { brandName, domain }
// Scrapes the domain and suggests topics + prompts. Always returns 200; the
// wizard reads `scraped` to decide whether to show suggestions or manual entry.
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
  const brandName = typeof body.brandName === "string" ? body.brandName.trim() : "";
  const domain = typeof body.domain === "string" ? body.domain.trim() : "";
  if (!brandName) {
    return NextResponse.json({ error: "Brand name is required." }, { status: 400 });
  }

  const scrape = domain
    ? await scrapeDomain(domain)
    : { ok: false as const, error: "Add your website so we can suggest topics." };

  const key = await resolveKey(supabase, user.id, pickDefaultProvider());
  if (!key.apiKey) {
    return NextResponse.json({
      scraped: false,
      description: "",
      topics: [],
      reason: key.source === "exhausted" ? "trial_exhausted" : "no_key",
      error: scrape.ok ? undefined : scrape.error,
    });
  }

  if (!scrape.ok || !scrape.text) {
    return NextResponse.json({
      scraped: false,
      description: "",
      topics: [],
      reason: "scrape_failed",
      error: scrape.error,
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
    if (key.source === "trial") await recordTrialUsage(supabase, suggestion.tokens);
    await logDashboard(user, request, {
      category: "onboarding",
      action: "onboarding.suggested",
      summary: `Analyzed ${domain || brandName} and suggested ${suggestion.topics.length} topic${suggestion.topics.length === 1 ? "" : "s"} with AI`,
      metadata: {
        topics: suggestion.topics.length,
        tokens: suggestion.tokens,
        keySource: key.source,
        domain,
      },
    });
    return NextResponse.json({
      scraped: suggestion.topics.length > 0,
      description: suggestion.description,
      topics: suggestion.topics,
      title: scrape.title ?? "",
    });
  } catch (e) {
    return NextResponse.json({
      scraped: false,
      description: "",
      topics: [],
      reason: "ai_failed",
      error: humanError(e),
    });
  }
}
