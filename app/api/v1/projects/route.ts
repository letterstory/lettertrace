import { NextResponse } from "next/server";
import { authenticateApiKey, bearerToken } from "@/lib/api-auth";
import { getProjects } from "@/lib/data";
import { createProject, projectSummary } from "@/lib/api-service";
import { humanError } from "@/lib/llm";

export const dynamic = "force-dynamic";

// GET /api/v1/projects — list the caller's organizations.
// Auth: Authorization: Bearer <lettertrace api key>
export async function GET(request: Request) {
  const auth = await authenticateApiKey(
    bearerToken(request.headers.get("authorization")),
  );
  if (!auth) {
    return NextResponse.json(
      { error: "Invalid or missing API key" },
      { status: 401 },
    );
  }

  const projects = await getProjects(auth.supabase, auth.userId);
  return NextResponse.json({ projects: projects.map(projectSummary) });
}

// POST /api/v1/projects — create an organization for the caller.
// Body: { name, brand_name, brand_aliases?, brand_domains?, description?,
//         default_provider?, default_model?, use_web_search? }
export async function POST(request: Request) {
  const auth = await authenticateApiKey(
    bearerToken(request.headers.get("authorization")),
  );
  if (!auth) {
    return NextResponse.json(
      { error: "Invalid or missing API key" },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const outcome = await createProject(
      auth.supabase,
      auth.userId,
      (body ?? {}) as Record<string, unknown>,
    );
    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.message }, { status: 400 });
    }
    return NextResponse.json(
      { project: projectSummary(outcome.project) },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
