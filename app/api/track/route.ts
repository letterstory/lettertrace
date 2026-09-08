import { NextRequest, NextResponse } from "next/server";
import { reportEngagement } from "@/lib/owned-access";

/**
 * Same-origin collector for the in-page engagement beacon on /blog.
 *
 * The beacon runs in the browser and must not hold the reporting key, so it
 * posts here (same origin, no credential) and this route forwards the engagement
 * to the owned-access ingest with the server-only key. Access reports (bots)
 * come through middleware instead; this endpoint is humans only.
 *
 * Always 204, even on bad input — a beacon is fire-and-forget and reads nothing.
 * Inert on forks / self-host: reportEngagement no-ops unless the owned-access
 * env is set.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      path?: unknown;
      from?: unknown;
      seconds?: unknown;
      scroll?: unknown;
    };
    if (typeof body?.path === "string" && body.path.startsWith("/")) {
      await reportEngagement({
        path: body.path,
        from: typeof body.from === "string" ? body.from : "",
        seconds: typeof body.seconds === "number" ? body.seconds : 0,
        scroll: typeof body.scroll === "number" ? body.scroll : 0,
      });
    }
  } catch {
    // Ignore — never surface a telemetry error to the page.
  }
  return new NextResponse(null, { status: 204 });
}
