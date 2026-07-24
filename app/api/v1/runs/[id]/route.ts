import { NextResponse } from "next/server";
import { authenticateApiKey, bearerToken } from "@/lib/api-auth";
import { getRunReport } from "@/lib/api-service";

export const dynamic = "force-dynamic";

// GET /api/v1/runs/:id — share-of-voice report for one run.
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

  const report = await getRunReport(auth.supabase, auth.userId, params.id);
  if (!report) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  return NextResponse.json(report);
}
