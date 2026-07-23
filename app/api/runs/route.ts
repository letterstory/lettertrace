import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";
import { executeRun } from "@/lib/engine";
import { humanError } from "@/lib/llm";
import { PROVIDERS } from "@/lib/models";
import { resolveRunKey, recordTrialUsage } from "@/lib/trial";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// POST /api/runs, execute a monitoring run now for the signed-in user's project.
export async function POST() {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await getProject(supabase, user.id);
  if (!project) {
    return NextResponse.json({ error: "Create a project first" }, { status: 400 });
  }

  const providerLabel = PROVIDERS[project.default_provider].label;
  const key = await resolveRunKey(supabase, user.id, project);

  if (key.source === "none") {
    return NextResponse.json(
      { error: `Add a ${providerLabel} key in Settings first.` },
      { status: 400 },
    );
  }
  if (key.source === "exhausted") {
    return NextResponse.json(
      {
        error: `You've used all ${key.limit?.toLocaleString()} free trial tokens. Add your own ${providerLabel} key in Settings to keep running.`,
        trialExhausted: true,
      },
      { status: 402 },
    );
  }

  try {
    const result = await executeRun({
      supabase,
      project,
      provider: key.provider,
      model: key.model,
      apiKey: key.apiKey!,
    });

    // Meter trial usage against the operator's shared key.
    if (key.source === "trial") {
      await recordTrialUsage(supabase, result.tokensUsed);
    }

    return NextResponse.json({ ...result, keySource: key.source });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
