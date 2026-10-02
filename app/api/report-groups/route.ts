import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getProject } from "@/lib/data";
import { isProvider, PROVIDERS, resolveEngine } from "@/lib/models";
import { engineKeyMessage, resolveRunKeyFor } from "@/lib/trial";
import type { Provider } from "@/lib/types";

export const dynamic = "force-dynamic";

// POST /api/report-groups, open a batch so the N runs the browser is about to
// start can be summarised in ONE email. It starts nothing itself.
export async function POST(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const project = await getProject(supabase, user.id);
  if (!project) return NextResponse.json({ error: "Create an organization first." }, { status: 400 });

  const body = await request.json().catch(() => null) as { providers?: unknown } | null;
  const providers = body?.providers;
  if (!Array.isArray(providers) || providers.length < 2 ||
      providers.length > Object.keys(PROVIDERS).length ||
      providers.some((provider) => !isProvider(provider)) ||
      new Set(providers).size !== providers.length) {
    return NextResponse.json({ error: "Choose at least two distinct available engines." }, { status: 400 });
  }
  const requested = providers as Provider[];

  const { count, error: promptError } = await supabase.from("prompts")
    .select("id", { count: "exact", head: true })
    .eq("project_id", project.id).eq("is_active", true);
  if (promptError) return NextResponse.json({ error: "Could not check active prompts. Try again." }, { status: 500 });
  if (!count) return NextResponse.json({ error: "Add active prompts before running reports." }, { status: 400 });

  // Refuse a batch that cannot produce a single report, and say why, rather
  // than opening one that finishes with nothing in it. Per-engine refusals are
  // left to /api/runs — it is the one that knows, at the moment each run is
  // attempted, whether the allowance is still there. This only answers "is
  // there any point starting at all".
  //
  // The OWNER's credential pays, whoever fired it, so resolve against them.
  const billing = createServiceClient();
  const refusals = await Promise.all(requested.map(async (provider) => {
    const engine = resolveEngine(provider, undefined);
    if (!engine.ok) return engine.message;
    const key = await resolveRunKeyFor(billing, project.user_id, engine.provider, engine.model, {
      webSearch: project.use_web_search,
    });
    const usable = (key.source === "own" || key.source === "trial") && Boolean(key.apiKey);
    return usable ? null : engineKeyMessage(key);
  }));
  if (refusals.every((refusal) => refusal !== null)) {
    return NextResponse.json({ error: refusals[0] as string }, { status: 400 });
  }

  const { data, error } = await billing.from("report_groups")
    .insert({ project_id: project.id, requested_providers: requested })
    .select("id").single();
  if (error) return NextResponse.json({ error: "Could not start the report group. Try again." }, { status: 500 });
  return NextResponse.json({ groupId: data.id }, { status: 201 });
}
