import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import { getRunReport } from "@/lib/api-service";

export const dynamic = "force-dynamic";

// GET /api/v1/runs/:id — share-of-voice report for one run.
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  const auth = await requireApiAuth(request, "runs:read", "v1");
  if (auth instanceof Response) return auth;

  const report = await getRunReport(auth.supabase, auth.userId, params.id);
  if (!report) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  return NextResponse.json(report);
}
