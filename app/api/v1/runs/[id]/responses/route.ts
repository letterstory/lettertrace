import { NextResponse } from "next/server";
import { authenticateApiKey, bearerToken } from "@/lib/api-auth";
import { getRunResponses } from "@/lib/api-service";

export const dynamic = "force-dynamic";

// GET /api/v1/runs/:id/responses — the run's raw artifacts: each response's
// full text plus the cited sources and detected mentions.
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

  const result = await getRunResponses(auth.supabase, auth.userId, params.id);
  if (!result) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  return NextResponse.json(result);
}
