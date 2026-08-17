import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { sendAdminAlert } from "@/lib/notify";
import { letterproveOrigin } from "@/lib/letterprove";

export const dynamic = "force-dynamic";

/**
 * Is our Letterprove integration still actually reporting?
 *
 * On 2026-08-14 it stopped for 65 hours and nothing said so. Letterprove had
 * moved to its own domain and the `*.vercel.app` alias we pointed at began
 * returning 404, so attest.js never loaded. Telemetry fails silently by design
 * — correctly, since it must never break a page — and the `x-letterprove`
 * diagnostic header only exists once a request is made, which a 404 on the
 * script prevents. The only symptom was a table that stopped growing, which is
 * indistinguishable from nobody signing in.
 *
 * So this checks the thing that actually broke: it fetches the exact URLs the
 * browser will use and reports when they are not reachable.
 *
 * WHY THIS LIVES HERE AND NOT IN LETTERPROVE. Letterprove's own /attest.js was
 * healthy for every one of those 65 hours — at its new address. What was
 * broken was *our reference to the old one*. A canary inside Letterprove
 * checking itself would have stayed green throughout. Only the consumer can
 * detect a consumer-side misconfiguration, which is the whole lesson of that
 * outage.
 *
 * Deliberately NOT an alert on event volume. The outage began on a Friday
 * night and the weekend legitimately looks quiet: any freshness threshold
 * short enough to catch it would cry wolf on every slow evening, and any
 * threshold long enough to stay silent over a weekend would not have fired
 * until Sunday. Volume infers breakage from absence of users; this observes
 * breakage directly.
 */
function authorized(header: string | null, secret: string | undefined): boolean {
  if (!header || !secret) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

interface Probe {
  what: string;
  url: string;
  ok: boolean;
  status: number | null;
  detail?: string;
}

const TIMEOUT_MS = 10_000;

async function probe(what: string, url: string): Promise<Probe> {
  try {
    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    // A redirect is a failure, not a pass: attest.js derives its collector
    // origin from its own `src`, so a script served from somewhere else
    // reports somewhere else.
    return { what, url, ok: res.status === 200, status: res.status };
  } catch (e) {
    return {
      what,
      url,
      ok: false,
      status: null,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

async function handle(request: Request) {
  if (!authorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const key = process.env.NEXT_PUBLIC_LETTERPROVE_KEY;
  // No key means this deployment does not report at all — a self-hoster, or a
  // preview. Nothing to check, and nothing to alert anyone about.
  if (!key) return NextResponse.json({ status: "not-configured" });

  const origin = letterproveOrigin();
  const probes = await Promise.all([
    probe("script", `${origin}/attest.js`),
    probe("config", `${origin}/api/v1/config?k=${encodeURIComponent(key)}`),
  ]);

  const failed = probes.filter((p) => !p.ok);
  if (failed.length > 0) {
    const lines = failed.map((p) => `  ${p.what}: ${p.url} -> ${p.detail ?? `HTTP ${p.status}`}`);
    await sendAdminAlert({
      subject: "Lettertrace is not reporting usage to Letterprove",
      body: [
        "The Letterprove integration is unreachable, so no usage is being recorded.",
        "",
        ...lines,
        "",
        `Configured origin: ${origin}`,
        "Set NEXT_PUBLIC_LETTERPROVE_ORIGIN if Letterprove has moved, then redeploy —",
        "the origin is read at build time.",
      ].join("\n"),
    });
  }

  // 200 even when a probe fails: the cron ran and reported correctly. A 500
  // here would mean "the check itself broke", and conflating the two is how a
  // monitor starts getting ignored.
  return NextResponse.json({
    status: failed.length ? "unhealthy" : "healthy",
    origin,
    probes,
  });
}

export const GET = handle;
export const POST = handle;
