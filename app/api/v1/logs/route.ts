import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import { queryActivityLogs, type LogQuery } from "@/lib/logs";
import { logApiRequest } from "@/lib/activity";
import { humanError } from "@/lib/llm";

export const dynamic = "force-dynamic";

// GET /api/v1/logs — the caller's activity feed (everything the Logs screen
// shows), filterable and paginated.
//
// Auth: Authorization: Bearer <lettertrace api key | oauth v1 token>.
// Gated on "projects:read": reading your own account telemetry is an
// account-read operation, and both classic keys and the first-party CLI already
// hold that scope, so no new scope (and no consent-screen change) is needed.
//
// Query: q, channel, category, status, actor, project, days, page, page_size.
export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "projects:read", "v1");
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const q = url.searchParams;
  const filters: LogQuery = {
    q: q.get("q") ?? undefined,
    channel: q.get("channel") ?? undefined,
    category: q.get("category") ?? undefined,
    status: q.get("status") ?? undefined,
    actorType: q.get("actor") ?? undefined,
    projectId: q.get("project") ?? undefined,
    days: q.get("days") ? Number(q.get("days")) : undefined,
    page: q.get("page") ? Number(q.get("page")) : 1,
    pageSize: q.get("page_size") ? Number(q.get("page_size")) : undefined,
  };

  try {
    const result = await queryActivityLogs(auth.supabase, auth.userId, filters);
    await logApiRequest(auth, request, "v1", {
      category: "system",
      action: "logs.read",
      summary: `Read ${result.rows.length} activity log ${result.rows.length === 1 ? "entry" : "entries"} via the API`,
      statusCode: 200,
      metadata: { total: result.total, page: result.page },
    });
    return NextResponse.json({
      logs: result.rows,
      total: result.total,
      page: result.page,
      page_size: result.pageSize,
      page_count: result.pageCount,
    });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
