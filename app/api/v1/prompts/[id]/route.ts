import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import { updatePrompt } from "@/lib/api-service";
import { logApiRequest } from "@/lib/activity";
import { humanError } from "@/lib/llm";

export const dynamic = "force-dynamic";

// PATCH /api/v1/prompts/:id — update a prompt.
// Body: { is_active?: boolean, target_url?: string | null }. target_url maps
// the prompt to the page it was written to surface (per-URL cited-hit rates
// in the run report); null clears the mapping.
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const auth = await requireApiAuth(request, "projects:write", "v1");
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as { is_active?: unknown; target_url?: unknown };

  const patch: { is_active?: boolean; target_url?: string | null } = {};
  if (b.is_active !== undefined) {
    if (typeof b.is_active !== "boolean") {
      return NextResponse.json(
        { error: "is_active must be a boolean." },
        { status: 400 },
      );
    }
    patch.is_active = b.is_active;
  }
  if (b.target_url !== undefined) {
    if (b.target_url !== null && typeof b.target_url !== "string") {
      return NextResponse.json(
        { error: "target_url must be a string, or null to clear it." },
        { status: 400 },
      );
    }
    patch.target_url = b.target_url as string | null;
  }

  try {
    const outcome = await updatePrompt(auth.supabase, auth.userId, params.id, patch);
    if (!outcome.ok) {
      const status = outcome.code === "not_found" ? 404 : 400;
      return NextResponse.json({ error: outcome.message }, { status });
    }
    await logApiRequest(auth, request, "v1", {
      category: "prompt",
      action: "prompt.updated",
      statusCode: 200,
      targetType: "prompt",
      targetId: params.id,
      summary: `Updated a prompt via the API (${Object.keys(patch).join(", ")})`,
      metadata: { fields: Object.keys(patch) },
    });
    return NextResponse.json({ prompt: outcome.prompt });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
