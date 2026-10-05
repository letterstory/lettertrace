/**
 * Product analytics for Lettertrace's own PostHog project.
 *
 * Raw fetch, no SDK: the same reason the provider adapters avoid one. A
 * capture that throws would turn a finished run into a 500, so this never
 * rejects — the same rule as logActivity.
 *
 * Off unless NEXT_PUBLIC_POSTHOG_KEY is set. That is the key the browser
 * snippet already uses, so a self-hosted image built without it reports
 * nothing from either side. The host is the same variable the snippet reads.
 * Hard-coding the US ingest host drops every event for an EU project: PostHog
 * answers 200 and stores nothing, which is how a working install looks dead.
 */

const DEFAULT_HOST = "https://us.i.posthog.com";
const CAPTURE_TIMEOUT_MS = 2_500;
const MICROS_PER_USD = 1_000_000;

export type AnalyticsTrigger = "manual" | "scheduled" | "onboarding";

/** The slice of a run's context that decides whose profile an event lands on. */
export interface AnalyticsActor {
  actorType?: string;
  actorId?: string | null;
  /** The account behind an API key or OAuth token. actorId there is the credential. */
  userId?: string | null;
  channel?: string;
  trigger?: AnalyticsTrigger;
}

export function posthogEnvironment(): string {
  const env = process.env.VERCEL_ENV?.trim();
  return env || "development";
}

export function posthogIngestHost(): string {
  const raw = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim();
  return (raw || DEFAULT_HOST).replace(/\/+$/, "");
}

/** Host only. A pasted URL must not carry its path into analytics. */
export function submittedDomain(raw: string): string {
  const trimmed = raw.trim();
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const host = new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
    return host || trimmed;
  } catch {
    return trimmed;
  }
}

/** Micro-dollars as a dollar number. Null/garbage is 0, not a thrown capture. */
export function usdFromMicros(micros: number | null | undefined): number {
  if (typeof micros !== "number" || !Number.isFinite(micros)) return 0;
  return Math.round(micros) / MICROS_PER_USD;
}

/**
 * Brand mentions over every brand and competitor mention. The same ratio
 * computeEntityStats stores on the brand row, so a funnel and a report can't
 * disagree about one run.
 */
export function brandShareOfVoice(brandMentions: number, competitorMentions: number): number {
  const total = brandMentions + competitorMentions;
  return total > 0 ? brandMentions / total : 0;
}

/**
 * Who the event is attached to.
 *
 * A dashboard click carries the person in actorId. An API or MCP call's
 * actorId is the credential, not the account, so the caller's user id is
 * passed separately. A cron tick has neither: the org owner is the only
 * person the run belongs to.
 */
export function analyticsDistinctId(billingOwnerId: string, ctx?: AnalyticsActor | null): string {
  if (ctx?.actorType === "user" && ctx.actorId) return ctx.actorId;
  if (ctx?.userId) return ctx.userId;
  return billingOwnerId;
}

/** manual, unless the caller named one or the run came from the scheduler. */
export function runTrigger(ctx?: AnalyticsActor | null): AnalyticsTrigger {
  if (ctx?.trigger) return ctx.trigger;
  if (ctx?.channel === "cron") return "scheduled";
  return "manual";
}

export interface TrialLimitKey {
  comped?: boolean;
  exhaustedBy?: "runs" | "spend";
  limit?: number;
  remaining?: number;
  spentMicros?: number;
  capMicros?: number;
}

/**
 * `atCap` is the consume-failure path: the resolver still thought a run was
 * left, and the atomic take said it wasn't. Count the allowance as used.
 */
export function trialLimitProperties(
  key: TrialLimitKey,
  trigger: AnalyticsTrigger,
  atCap = false,
): Record<string, unknown> {
  const runLimit = key.limit ?? 0;
  const runsUsed = atCap
    ? runLimit
    : typeof key.remaining === "number"
      ? Math.max(0, runLimit - key.remaining)
      : runLimit;
  const limitType =
    key.exhaustedBy ??
    (typeof key.spentMicros === "number" &&
    typeof key.capMicros === "number" &&
    key.spentMicros >= key.capMicros
      ? "spend"
      : "runs");
  return {
    limit_type: limitType,
    runs_used: runsUsed,
    run_limit: runLimit,
    spend_used_usd: usdFromMicros(key.spentMicros),
    spend_limit_usd: usdFromMicros(key.capMicros),
    trigger,
  };
}

export async function captureServerEvent(
  distinctId: string | null | undefined,
  event: string,
  properties?: Record<string, unknown> | null,
): Promise<void> {
  try {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
    const id = typeof distinctId === "string" ? distinctId.trim() : "";
    if (!key || !id) return;

    const props: Record<string, unknown> = { environment: posthogEnvironment() };
    if (properties) {
      for (const [name, value] of Object.entries(properties)) {
        if (value !== undefined) props[name] = value;
      }
    }

    const res = await fetch(`${posthogIngestHost()}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        event,
        distinct_id: id,
        properties: props,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[posthog] ${event} was not stored (HTTP ${res.status}).`);
    } else if (process.env.NODE_ENV === "development") {
      // Local `next dev` only. Vercel sets NODE_ENV=production even on Preview,
      // so this line never shows up in a deployment log.
      console.info(`[posthog] captured ${event} distinct_id=${id}`);
    }
  } catch (err) {
    console.warn(
      `[posthog] ${event} was not stored:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * A blocked run. Comped accounts have no limit, so they never emit this.
 * `compedAccount` is the COMPED_USER_IDS check (lib/trial.isCompedUser). It
 * is passed in rather than imported: lib/trial pulls in the data layer, and
 * this module is loaded from route tests that replace React's cache().
 */
export async function captureTrialLimit(args: {
  distinctId: string;
  billingOwnerId: string;
  orgId?: string | null;
  channel: string;
  trigger: AnalyticsTrigger;
  key: TrialLimitKey;
  atCap?: boolean;
  compedAccount?: boolean;
}): Promise<void> {
  if (args.key.comped || args.compedAccount) return;
  await captureServerEvent(args.distinctId, "trial_limit_reached", {
    ...(args.orgId ? { org_id: args.orgId } : {}),
    billing_owner_id: args.billingOwnerId,
    channel: args.channel,
    ...trialLimitProperties(args.key, args.trigger, args.atCap),
  });
}
