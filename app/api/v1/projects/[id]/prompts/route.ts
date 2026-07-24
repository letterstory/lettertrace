import { NextResponse } from "next/server";
import { authenticateApiKey, bearerToken } from "@/lib/api-auth";
import { createPrompts, listProjectPrompts } from "@/lib/api-service";
import { humanError } from "@/lib/llm";

export const dynamic = "force-dynamic";

// GET /api/v1/projects/:id/prompts — the project's prompts with topic names.
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

  const prompts = await listProjectPrompts(auth.supabase, auth.userId, params.id);
  if (!prompts) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json({ prompts });
}

// POST /api/v1/projects/:id/prompts — bulk-add prompts, get-or-creating each
// topic by name. Body: { prompts: [{ text, topic }] }
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { prompts } = (body ?? {}) as { prompts?: unknown };

  try {
    const outcome = await createPrompts(
      auth.supabase,
      auth.userId,
      params.id,
      prompts,
    );
    if (!outcome.ok) {
      return NextResponse.json(
        { error: outcome.message },
        { status: outcome.code === "not_found" ? 404 : 400 },
      );
    }
    return NextResponse.json(
      { created: outcome.created, skipped: outcome.skipped },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
