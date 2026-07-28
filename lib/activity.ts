import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ApiAuthContext, ResourceAudience, TokenType } from "@/lib/api-auth";
import type { ActorType, LogCategory, LogChannel, LogStatus } from "@/lib/types";

// Re-export for callers that build actor/channel bits without pulling types.ts.
export type { LogCategory, LogChannel, LogStatus } from "@/lib/types";

// ==================================================================
// Activity logging — the single write path behind the "Logs" screen.
//
// One rule governs everything here: logging MUST NEVER break the action it is
// recording. Every failure (no service key, insert error, bad input) is
// swallowed. A telemetry write that throws would turn a successful run into a
// 500, so logActivity always resolves and never rejects.
//
// Writes go through a dedicated service-role client, NOT the caller's request
// client. That keeps the feed un-forgeable (RLS lets clients read their own
// rows but never insert) and lets any surface — cookie route, API route, cron —
// log with the same call. NOTHING secret is ever passed in: key hints and
// client ids only, never plaintext keys or tokens.
// ==================================================================

export interface ActivityInput {
  /** The account the event belongs to. Null only for ownerless system events. */
  userId?: string | null;
  projectId?: string | null;
  actorType: ActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  channel: LogChannel;
  category: LogCategory | string;
  action: string;
  status?: LogStatus;
  targetType?: string | null;
  targetId?: string | null;
  summary: string;
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
  ip?: string | null;
  userAgent?: string | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown> | null;
}

// A single service-role client, reused across calls. Built lazily so importing
// this module never throws when the key is absent (tests, preview builds).
let cached: SupabaseClient | null = null;
let warned = false;

function logger(): SupabaseClient | null {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    if (!warned) {
      warned = true;
      // Once, quietly: logging degrades to a no-op rather than crashing callers.
      console.warn(
        "[activity] SUPABASE_SERVICE_ROLE_KEY not set; activity logging disabled.",
      );
    }
    return null;
  }
  cached = createSupabaseClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) },
  });
  return cached;
}

function cap(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Record one event. Best-effort and non-throwing — await it for durability in
 * serverless (so the row lands before the function freezes), but a rejection
 * here can never surface to the caller.
 */
export async function logActivity(event: ActivityInput): Promise<void> {
  try {
    const db = logger();
    if (!db) return;
    await db.from("activity_logs").insert({
      user_id: event.userId ?? null,
      project_id: event.projectId ?? null,
      actor_type: event.actorType,
      actor_id: event.actorId ?? null,
      actor_label: cap(event.actorLabel, 200),
      channel: event.channel,
      category: event.category,
      action: event.action,
      status: event.status ?? "success",
      target_type: event.targetType ?? null,
      target_id: event.targetId ?? null,
      // `||` (not `??`) so an empty summary also falls back to the action —
      // cap() returns "" for an empty string, which `??` would let through.
      summary: cap(event.summary, 500) || event.action,
      method: event.method ?? null,
      path: cap(event.path, 500),
      status_code: event.statusCode ?? null,
      ip: cap(event.ip, 100),
      user_agent: cap(event.userAgent, 400),
      duration_ms:
        typeof event.durationMs === "number" ? Math.round(event.durationMs) : null,
      metadata: event.metadata ?? {},
    });
  } catch (err) {
    // Never let telemetry take down the primary action.
    console.warn("[activity] failed to write log:", err);
  }
}

/** Request shape (ip, user agent, method, path) pulled from a Fetch Request.
 *  Route handlers get a plain Request, so the client ip lives in proxy headers,
 *  never on the object. */
export function requestMeta(request: Request): {
  method: string;
  path: string | null;
  ip: string | null;
  userAgent: string | null;
} {
  const h = request.headers;
  const forwarded = h.get("x-forwarded-for");
  const ip = forwarded ? forwarded.split(",")[0]!.trim() : h.get("x-real-ip");
  let path: string | null = null;
  try {
    path = new URL(request.url).pathname;
  } catch {
    path = null;
  }
  return {
    method: request.method,
    path,
    ip: ip || null,
    userAgent: h.get("user-agent"),
  };
}

/** Friendly label for an OAuth client id (first-party CLI gets a proper name). */
export function clientLabel(clientId: string | null | undefined): string {
  if (!clientId) return "OAuth client";
  if (clientId === "lt_cli") return "Lettertrace CLI & MCP";
  return clientId;
}

/**
 * The surface a credential is calling through. actor_type is the credential
 * kind; channel is where the call arrived. An OAuth token minted for the CLI
 * shows as channel 'cli'; the same token class against MCP shows as 'mcp'.
 */
export function deriveChannel(opts: {
  tokenType: TokenType;
  clientId: string | null;
  surface: ResourceAudience;
}): LogChannel {
  if (opts.surface === "mcp") return "mcp";
  // REST (v1) surface: the first-party CLI is its own channel; everything else
  // (classic keys, third-party OAuth) is the generic API.
  return opts.clientId === "lt_cli" ? "cli" : "api";
}

/** Actor + channel fields for a programmatic (API-key / OAuth) caller. */
export function apiActor(
  ctx: ApiAuthContext,
  surface: ResourceAudience,
): Pick<ActivityInput, "actorType" | "actorId" | "actorLabel" | "channel"> {
  const isOAuth = ctx.tokenType === "oauth";
  return {
    actorType: isOAuth ? "oauth" : "api_key",
    actorId: ctx.keyId,
    actorLabel: isOAuth ? clientLabel(ctx.clientId) : "API key",
    channel: deriveChannel({
      tokenType: ctx.tokenType,
      clientId: ctx.clientId,
      surface,
    }),
  };
}

/**
 * Log a signed-in user's dashboard action. Fills in the user actor, the
 * dashboard channel, and the request metadata; the caller supplies the verb.
 */
export async function logDashboard(
  user: { id: string; email?: string | null },
  request: Request,
  event: {
    category: LogCategory | string;
    action: string;
    summary: string;
    status?: LogStatus;
    projectId?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  const meta = requestMeta(request);
  await logActivity({
    userId: user.id,
    actorType: "user",
    actorId: user.id,
    actorLabel: user.email ?? "You",
    channel: "dashboard",
    method: meta.method,
    path: meta.path,
    ip: meta.ip,
    userAgent: meta.userAgent,
    ...event,
  });
}

/**
 * Log one authenticated request to the programmatic surface (REST v1 or MCP),
 * filling in the actor, channel, and request metadata from the auth context and
 * the Request. The caller supplies only what it knows about the outcome.
 */
export async function logApiRequest(
  ctx: ApiAuthContext,
  request: Request,
  surface: ResourceAudience,
  event: {
    category: LogCategory | string;
    action: string;
    summary: string;
    status?: LogStatus;
    statusCode?: number | null;
    projectId?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    durationMs?: number | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  const meta = requestMeta(request);
  await logActivity({
    userId: ctx.userId,
    ...apiActor(ctx, surface),
    method: meta.method,
    path: meta.path,
    ip: meta.ip,
    userAgent: meta.userAgent,
    ...event,
  });
}
