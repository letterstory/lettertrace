import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { ConfigurationError } from "@/lib/crypto";
import { decryptedSearchKey } from "@/lib/search-keys";
import { collectWebMentions } from "@/lib/web-mentions";
import { recordOpsError } from "@/lib/ops";
import type { Project, Topic, WebMentionWatch } from "@/lib/types";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// The web-mentions scheduler. A separate cron from /api/cron/run on purpose:
// the two signals must not share a failure domain or a function clock — a
// slow LLM portfolio should never cost a search tick, or vice versa.
//
// The cron FIRES daily but each project COLLECTS weekly: a project is due
// when it has never collected or last collected >= 7 days ago. Daily firing
// self-heals drift (a missed tick delays a project one day, not one week)
// and spreads projects enabled on different days across the week naturally.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Cross-project ceiling per tick. A brake against many runaway configs at
 *  once, not a budget: at Brave's pricing this caps a tick at ~$2. Projects
 *  left over stay due and collect on the next daily firing. */
const GLOBAL_QUERY_CEILING = 400;

function isDue(watch: WebMentionWatch, now: number): boolean {
  if (!watch.last_collected_at) return true;
  return now - new Date(watch.last_collected_at).getTime() >= WEEK_MS;
}

interface WatchResult {
  projectId: string;
  status: "completed" | "failed" | "skipped";
  reason?: string;
  runId?: string;
  queryCount?: number;
  newCount?: number;
  seenCount?: number;
}

// Same constant-time auth as /api/cron/run, same CRON_SECRET.
function authorized(header: string | null, secret: string | undefined): boolean {
  if (!header || !secret) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handle(request: Request) {
  if (!authorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const now = Date.now();

  // Oldest collection first, never-collected before that: the projects that
  // have waited longest get the global ceiling's headroom first.
  const { data: watchRows, error: watchErr } = await supabase
    .from("web_mention_watch")
    .select("*")
    .eq("enabled", true)
    .order("last_collected_at", { ascending: true, nullsFirst: true });
  if (watchErr) {
    return NextResponse.json({ error: watchErr.message }, { status: 500 });
  }

  const watches = ((watchRows ?? []) as WebMentionWatch[]).filter((w) => isDue(w, now));
  const results: WatchResult[] = [];
  let remaining = GLOBAL_QUERY_CEILING;

  for (const watch of watches) {
    if (remaining <= 0) {
      results.push({ projectId: watch.project_id, status: "skipped", reason: "tick ceiling" });
      continue;
    }

    try {
      const { data: projectRow } = await supabase
        .from("projects")
        .select("*")
        .eq("id", watch.project_id)
        .maybeSingle();
      const project = projectRow as Project | null;
      if (!project) {
        results.push({ projectId: watch.project_id, status: "skipped", reason: "project gone" });
        continue;
      }

      // Strictly self-funded, like scheduled LLM runs: no stored key, no
      // collection — an unattended schedule can never spend operator money.
      const apiKey = await decryptedSearchKey(supabase, project.user_id, "brave");
      if (!apiKey) {
        results.push({ projectId: watch.project_id, status: "skipped", reason: "no key" });
        continue;
      }

      const { data: topicRows } = await supabase
        .from("topics")
        .select("*")
        .eq("project_id", project.id)
        .order("created_at");

      const result = await collectWebMentions({
        supabase,
        project,
        watch,
        topics: (topicRows ?? []) as Topic[],
        apiKey,
        maxQueries: remaining,
      });
      remaining -= result.queryCount;
      results.push({
        projectId: watch.project_id,
        status: result.status,
        runId: result.runId,
        queryCount: result.queryCount,
        newCount: result.newCount,
        seenCount: result.seenCount,
        reason: result.error,
      });
    } catch (e) {
      // A stored key this deployment can't decrypt is the operator's problem
      // (rotated ENCRYPTION_KEY), and must read differently from "no key",
      // which tells the user to add one they already added.
      const reason =
        e instanceof ConfigurationError
          ? `decryption unavailable: ${e.message}`
          : e instanceof Error
            ? e.message
            : "unknown error";
      recordOpsError("cron.web-mentions", e, { project_id: watch.project_id });
      results.push({ projectId: watch.project_id, status: "failed", reason });
    }
  }

  return NextResponse.json({ processed: results, dueCount: watches.length });
}

export async function POST(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  return handle(request);
}
