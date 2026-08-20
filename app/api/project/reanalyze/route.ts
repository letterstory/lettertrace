import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";
import { scrapeDomain } from "@/lib/scrape";
import { suggestFromSite, humanError } from "@/lib/llm";
import { PROVIDERS } from "@/lib/models";
import { resolveKey, recordTrialUsage, recordTrialSpend } from "@/lib/trial";
import { spendMicros } from "@/lib/pricing";
import { logDashboard } from "@/lib/activity";
import type { Topic } from "@/lib/types";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// POST /api/project/reanalyze
// Re-run the onboarding site analysis for an existing project: re-read the
// site, fold in the workspace description and the topics already tracked, and
// return DRAFT topic suggestions. Nothing is saved — the user accepts each
// suggestion (POST /api/topics with prompts) or ignores it. Onboarding was the
// only caller of scrapeDomain/suggestFromSite before this; a project whose
// prompts drifted from what the company actually does had no way back.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const project = await getProject(supabase, user.id);
  if (!project) {
    return NextResponse.json({ error: "Create a project first" }, { status: 400 });
  }

  const providerLabel = PROVIDERS[project.default_provider].label;
  // Lenient resolution on purpose: suggestions are drafts the user reviews
  // before anything is saved, so any key they hold will do — same stance as
  // competitor suggestions and the Generate button.
  const key = await resolveKey(supabase, user.id, project.default_provider, project.default_model);

  if (key.source === "none") {
    return NextResponse.json(
      { error: `Add a ${providerLabel} key in Settings first.` },
      { status: 400 },
    );
  }
  if (key.source === "exhausted") {
    return NextResponse.json(
      {
        error: `You've used all ${key.limit ?? 0} free runs. Add your own ${providerLabel} key in Settings to keep going.`,
        trialExhausted: true,
      },
      { status: 402 },
    );
  }

  // Best-effort scrape of the primary domain. A failed read is not fatal here
  // the way it is in onboarding: an existing project usually has a description
  // to work from, and the model is told the site was unreadable.
  const domain = project.brand_domains[0] ?? null;
  const scrape = domain ? await scrapeDomain(domain) : null;
  const siteText = scrape?.ok ? (scrape.text ?? "") : "";

  if (!siteText && !project.description) {
    return NextResponse.json(
      {
        error: domain
          ? `We couldn't read ${domain} (${scrape?.error ?? "unknown error"}) and this workspace has no description. Add one in Settings ("What does your brand do?") and try again.`
          : `This workspace has no brand domain and no description. Add either in Settings and try again.`,
      },
      { status: 400 },
    );
  }

  const { data: topicRows } = await supabase
    .from("topics")
    .select("name")
    .eq("project_id", project.id);
  const existingTopics = ((topicRows ?? []) as Pick<Topic, "name">[]).map((t) => t.name);

  try {
    const { description, topics, tokens } = await suggestFromSite({
      provider: key.provider,
      model: key.model,
      apiKey: key.apiKey!,
      brandName: project.brand_name,
      siteText,
      description: project.description,
      existingTopics,
    });

    // Metered even though no free RUN is consumed: these endpoints spend the
    // operator's key, so without this a script could call them forever.
    if (key.source === "trial") {
      await recordTrialUsage(supabase, tokens);
      await recordTrialSpend(
        supabase,
        spendMicros({ provider: key.provider, model: key.model, tokens }),
      );
    }

    // Belt-and-braces: the model is told not to repeat tracked topics, but a
    // rename-level duplicate ("Payroll software" vs "payroll tools") is on the
    // model; only exact case-insensitive repeats are cheap to catch here.
    const taken = new Set(existingTopics.map((t) => t.trim().toLowerCase()));
    const fresh = topics.filter((t) => !taken.has(t.name.trim().toLowerCase()));

    await logDashboard(user, request, {
      category: "topic",
      action: "topic.reanalyzed",
      summary: `Re-analyzed the site and drafted ${fresh.length} topic suggestion${fresh.length === 1 ? "" : "s"}`,
      projectId: project.id,
      targetType: "project",
      targetId: project.id,
      metadata: { count: fresh.length, tokens, keySource: key.source, scraped: Boolean(siteText) },
    });

    return NextResponse.json({
      suggestions: fresh,
      // Surfaced so the UI can say the drafts came from the description alone —
      // a silently unread site would otherwise look like a thin model response.
      scraped: Boolean(siteText),
      scrapeError: scrape && !scrape.ok ? scrape.error ?? null : null,
      inferredDescription: description || null,
    });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
