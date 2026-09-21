import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { sweepAbandonedGroups } from "@/lib/report-groups";

// Nothing here executes a run: the browser drives those. This tick only closes
// out batches the browser stopped driving, so it needs a request's worth of
// time rather than a run's.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Same shape as the other cron routes: POST for a manual kick, GET for Vercel
// Cron, which sends the Authorization: Bearer $CRON_SECRET header.
function authorized(header: string | null, secret: string | undefined): boolean {
  if (!header || !secret) return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function handle(request: Request) {
  if (!authorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const closed = await sweepAbandonedGroups(createServiceClient());
    return NextResponse.json({ closed });
  } catch (cause) {
    console.error(`[report-groups] sweep failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    return NextResponse.json({ error: "Report group sweep failed; check logs." }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
