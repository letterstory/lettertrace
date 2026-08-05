import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import { listRuns, triggerRunForProject } from "@/lib/api-service";
import { apiActor, logApiRequest } from "@/lib/activity";
import { isProvider, PROVIDERS } from "@/lib/models";
import { humanError } from "@/lib/llm";
import type { Provider } from "@/lib/types";

export const maxDuration = 800;
export const dynamic = "force-dynamic";

// GET /api/v1/projects/:id/runs — recent runs for a project (?limit=20).
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  const auth = await requireApiAuth(request, "runs:read", "v1");
  if (auth instanceof Response) return auth;

  const limit = Number(new URL(request.url).searchParams.get("limit")) || 20;
  const runs = await listRuns(auth.supabase, auth.userId, params.id, limit);
  if (!runs) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  await logApiRequest(auth, request, "v1", {
    category: "run",
    action: "api.list_runs",
    summary: `Listed ${runs.length} run${runs.length === 1 ? "" : "s"} via the API`,
    statusCode: 200,
    projectId: params.id,
    targetType: "project",
    targetId: params.id,
  });
  return NextResponse.json({ runs });
}

// POST /api/v1/projects/:id/runs — execute a monitoring run now (BYOK-only).
// Optional body { provider?, model?, background? } — provider/model override
// the project default for this run; background: true returns 202 as soon as
// the run row exists (a run takes minutes; poll GET /v1/runs/:id/status).
// No body keeps the default, synchronous behavior.
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const auth = await requireApiAuth(request, "runs:trigger", "v1");
  if (auth instanceof Response) return auth;

  // An absent (or empty) body is the common case and must keep working.
  const options: { provider?: Provider; model?: string; background?: boolean } = {};
  let raw: unknown = null;
  try {
    raw = await request.json();
  } catch {
    // No JSON body: run with the project's default provider/model.
  }
  if (raw && typeof raw === "object") {
    const b = raw as Record<string, unknown>;
    if (typeof b.provider === "string" && b.provider.length > 0) {
      if (!isProvider(b.provider)) {
        return NextResponse.json(
          {
            error: `Unknown provider "${b.provider}". Use one of: ${Object.keys(PROVIDERS).join(", ")}.`,
          },
          { status: 400 },
        );
      }
      options.provider = b.provider;
    }
    if (typeof b.model === "string" && b.model.trim().length > 0) {
      options.model = b.model.trim();
    }
    if (b.background === true) {
      options.background = true;
    }
  }

  try {
    // Attribute the run itself (logged by the engine) to this API/CLI caller.
    const outcome = await triggerRunForProject(
      auth.supabase,
      auth.userId,
      params.id,
      { ...options, context: apiActor(auth, "v1") },
    );
    if (!outcome.ok) {
      // not_found -> 404, a bad engine override -> 400, no key -> 402 (billing).
      const status =
        outcome.code === "not_found" ? 404 : outcome.code === "invalid_engine" ? 400 : 402;
      await logApiRequest(auth, request, "v1", {
        category: "run",
        action: "api.trigger_run",
        status: "failure",
        statusCode: status,
        projectId: params.id,
        targetType: "project",
        targetId: params.id,
        summary: `Run not triggered via the API: ${outcome.message}`,
        metadata: { reason: outcome.code },
      });
      return NextResponse.json({ error: outcome.message }, { status });
    }
    // A background acceptance is 202 (created and executing, not settled);
    // the synchronous path stays 200 with the settled result.
    const statusCode = outcome.result.status === "running" ? 202 : 200;
    await logApiRequest(auth, request, "v1", {
      category: "run",
      action: "api.trigger_run",
      statusCode,
      projectId: params.id,
      targetType: "run",
      targetId: outcome.result.runId,
      summary: `Triggered a run via the API (${outcome.result.status})`,
    });
    return NextResponse.json(outcome.result, { status: statusCode });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
