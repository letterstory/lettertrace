import { NextResponse } from "next/server";
import { authenticateApiKey, bearerToken } from "@/lib/api-auth";
import { getProjects } from "@/lib/data";
import { projectSummary } from "@/lib/api-service";

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
