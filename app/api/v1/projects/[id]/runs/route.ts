import { NextResponse } from "next/server";
import { authenticateApiKey, bearerToken } from "@/lib/api-auth";
import { listRuns, triggerRunForProject } from "@/lib/api-service";
import { humanError } from "@/lib/llm";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// GET /api/v1/projects/:id/runs — recent runs for a project (?limit=20).
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  const auth = await authenticateApiKey(
    bearerToken(request.headers.get("authorization")),
  );
  if (!auth) {
    return NextResponse.json(
      { error: "Invalid or missing API key" },
      { status: 401 },
    );
  }

  const limit = Number(new URL(request.url).searchParams.get("limit")) || 20;
  const runs = await listRuns(auth.supabase, auth.userId, params.id, limit);
  if (!runs) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json({ runs });
}

// POST /api/v1/projects/:id/runs — execute a monitoring run now (BYOK-only).
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const auth = await authenticateApiKey(
    bearerToken(request.headers.get("authorization")),
  );
  if (!auth) {
    return NextResponse.json(
      { error: "Invalid or missing API key" },
      { status: 401 },
    );
  }

  try {
    const outcome = await triggerRunForProject(
      auth.supabase,
      auth.userId,
      params.id,
    );
    if (!outcome.ok) {
      return NextResponse.json(
        { error: outcome.message },
        { status: outcome.code === "not_found" ? 404 : 402 },
      );
    }
    return NextResponse.json(outcome.result);
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
