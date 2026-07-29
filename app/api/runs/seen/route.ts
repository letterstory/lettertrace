import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";
import { markResultsSeen } from "@/lib/results-seen";
import { humanError } from "@/lib/llm";

export const dynamic = "force-dynamic";

// POST /api/runs/seen — record that the signed-in user has looked at their
// active project's results, clearing the "run finished" nudge.
//
// Two callers, deliberately different: opening a run report sends that run's
// id, so the mark lands on its finish time and a NEWER unread run stays
// flagged; dismissing the banner sends nothing, acknowledging everything so far.
export async function POST(request: Request) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await getProject(supabase, user.id);
  if (!project) {
    return NextResponse.json({ error: "No project" }, { status: 400 });
  }

  let runId: string | null = null;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body?.runId === "string" && body.runId.trim()) runId = body.runId.trim();
  } catch {
    // No body at all is the dismiss case, not an error.
  }

  try {
    const outcome = await markResultsSeen(supabase, project, runId);
    if (!outcome.ok) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }
    // `changed` lets the viewer skip a router.refresh() it doesn't need, which
    // is what keeps mark-on-view from bouncing between write and re-render.
    return NextResponse.json({ changed: outcome.changed, seenAt: outcome.seenAt });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
