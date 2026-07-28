import { createServiceClient } from "@/lib/supabase/service";

// A tiny fixed-window, DB-counter rate limiter. express-rate-limit (what the MCP
// SDK's own auth router uses) is Express-only and cannot run in App Router route
// handlers, and this deployment has no guaranteed Redis — so the counter lives
// in Postgres (public.oauth_rate_limits) and is bumped atomically by the
// oauth_rate_touch() function, which resets its own window.
//
// It fails OPEN on infrastructure error: a database blip must not lock every
// user out of signing in. That is a deliberate availability trade — the
// brute-force-critical paths (the device user_code) additionally carry an
// in-SQL attempts cap that does NOT depend on this limiter, so a fail-open here
// never removes the last line of defense.

export interface RateLimitResult {
  allowed: boolean;
  count: number;
}

export async function rateLimit(
  bucket: string,
  windowSeconds: number,
  limit: number,
): Promise<RateLimitResult> {
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase.rpc("oauth_rate_touch", {
      p_bucket: bucket,
      p_window_seconds: windowSeconds,
      p_limit: limit,
    });
    if (error || !data) {
      console.error("[oauth] rate limiter unavailable:", error?.message);
      return { allowed: true, count: 0 };
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
      allowed: Boolean(row?.allowed),
      count: Number(row?.current_count ?? 0),
    };
  } catch (e) {
    console.error(
      "[oauth] rate limiter threw:",
      e instanceof Error ? e.message : e,
    );
    return { allowed: true, count: 0 };
  }
}

/**
 * Best-effort client IP for bucketing, read from the usual proxy headers. Only
 * used to spread abuse counters — never as an auth signal — so a spoofed value
 * costs the attacker nothing they didn't already have.
 */
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim() || "unknown";
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}
