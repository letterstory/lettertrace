import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";
import { suggestCompetitors, humanError } from "@/lib/llm";
import { PROVIDERS } from "@/lib/models";
import { resolveKey, recordTrialUsage, recordTrialSpend } from "@/lib/trial";
import { spendMicros } from "@/lib/pricing";
import { logDashboard } from "@/lib/activity";
import type { Competitor, Topic } from "@/lib/types";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// POST /api/competitors/suggest
// Ask the model for direct competitors of the active org's brand, excluding
// ones already tracked. Uses the same key resolution (own -> trial) as runs.
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

  const [{ data: competitorRows }, { data: topicRows }] = await Promise.all([
    supabase.from("competitors").select("*").eq("project_id", project.id),
    supabase.from("topics").select("*").eq("project_id", project.id),
  ]);
  const existing = ((competitorRows ?? []) as Competitor[]).map((c) => c.name);
  const topics = ((topicRows ?? []) as Topic[]).map((t) => t.name);

  const providerLabel = PROVIDERS[project.default_provider].label;
  // Lenient resolution on purpose: suggesting competitor names is a helper the
  // user edits before anything is saved, so any key they hold will do. Runs are
  // the opposite — see resolveRunKey.
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

  try {
    const { suggestions, tokens } = await suggestCompetitors({
      provider: key.provider,
      model: key.model,
      apiKey: key.apiKey!,
      brandName: project.brand_name,
      brandDomain: project.brand_domains[0] ?? null,
      description: project.description,
      topics,
      existing,
      count: 6,
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

    // Belt-and-braces: drop the brand itself and anything already tracked,
    // including tracked competitors' aliases (e.g. "Monday" vs "Monday.com").
    const competitorAliases = ((competitorRows ?? []) as Competitor[]).flatMap(
      (c) => c.aliases,
    );
    const taken = new Set(
      [project.brand_name, ...project.brand_aliases, ...existing, ...competitorAliases].map(
        (n) => n.trim().toLowerCase(),
      ),
    );
    // Adding as we go also collapses repeats *within* this batch, so a model
    // that names the same competitor twice can't get two rows past the UI.
    const fresh = suggestions.filter((s) => {
      const name = s.name.trim().toLowerCase();
      if (taken.has(name)) return false;
      taken.add(name);
      return true;
    });

    await logDashboard(user, request, {
      category: "competitor",
      action: "competitor.suggested",
      summary: `Generated ${fresh.length} competitor suggestion${fresh.length === 1 ? "" : "s"} with AI`,
      projectId: project.id,
      targetType: "project",
      targetId: project.id,
      metadata: { count: fresh.length, tokens, keySource: key.source },
    });

    return NextResponse.json({ suggestions: fresh });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
