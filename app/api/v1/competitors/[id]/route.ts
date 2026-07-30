import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import { deleteCompetitor } from "@/lib/api-service";
import { logApiRequest } from "@/lib/activity";
import { humanError } from "@/lib/llm";

export const dynamic = "force-dynamic";

// DELETE /api/v1/competitors/:id — stop tracking a competitor. Past mention
// rows keep the entity name they recorded, so old reports stay intact.
export async function DELETE(
  request: Request,
  { params }: { params: { id: string } },
) {
  const auth = await requireApiAuth(request, "projects:write", "v1");
  if (auth instanceof Response) return auth;

  try {
    const removed = await deleteCompetitor(auth.supabase, auth.userId, params.id);
    if (!removed) {
      return NextResponse.json({ error: "Competitor not found" }, { status: 404 });
    }
    await logApiRequest(auth, request, "v1", {
      category: "competitor",
      action: "api.delete_competitor",
      summary: `Removed competitor "${removed.name}" via the API`,
      statusCode: 200,
      targetType: "competitor",
      targetId: params.id,
    });
    return NextResponse.json({ ok: true, removed });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
