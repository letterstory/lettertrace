import { NextResponse } from "next/server";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { humanError } from "@/lib/llm";
import { recordOps } from "@/lib/ops";

/**
 * The one place an API route's 5xx is written down.
 *
 * Until this existed, a REST route that threw answered the caller with a 500
 * and told nobody else: the request span stayed unset (status_code 0, no
 * message) and no log record was emitted, because the only `ops.*` events in
 * the app describe runs and provider calls. Five PATCH /api/v1/projects/:id
 * 500s on 2026-09-11 (a teammate's update hitting an owner-scoped query, so
 * PostgREST answered 406) were undiagnosable from telemetry for exactly that
 * reason.
 *
 * Same rules as lib/ops.ts: never throw, never block, never record content.
 * Route, method, status, error class, the scrubbed message and a PostgREST
 * error code are recorded. The request body and headers are not read.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const MESSAGE_LIMIT = 500;

/** `/api/v1/projects/<uuid>` -> `/api/v1/projects/:id`, so one route is one value. */
function routeOf(request: Request): string {
  try {
    return new URL(request.url).pathname.replace(UUID, ":id");
  } catch {
    return "unknown";
  }
}

/** PostgREST errors carry a string `code` (PGRST116, 23505, ...) and `details`. */
function postgrestCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as { code?: unknown; details?: unknown; name?: unknown };
  if (typeof e.code !== "string") return null;
  return e.name === "PostgrestError" || "details" in e ? e.code : null;
}

/**
 * Record a failed API request as an `api.error` ops event (and so as an OTel
 * log record correlated with the active request span) and mark the span as
 * failed. Only 5xx outcomes are recorded; a 4xx is the caller's problem and is
 * already visible on the span.
 */
export function recordApiFailure(request: Request, error: unknown, status = 500): void {
  if (status < 500) return;
  try {
    const name = error instanceof Error ? error.name : "Error";
    const message = (error instanceof Error ? error.message : String(error)).slice(
      0,
      MESSAGE_LIMIT,
    );
    const method = request.method.toUpperCase();
    const route = routeOf(request);
    const dbCode = postgrestCode(error);

    recordOps("api.error", {
      level: "error",
      signature: `${method} ${route}: ${name}: ${message}`,
      sample: {
        method,
        route,
        status,
        name,
        message,
        ...(dbCode ? { db_code: dbCode } : {}),
      },
    });

    const span = trace.getActiveSpan();
    if (span) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      // The class, not the message: span status text leaves this deployment
      // and the content rule in lib/otel applies.
      span.setStatus({ code: SpanStatusCode.ERROR, message: name });
    }
  } catch {
    // A telemetry pipeline must not be able to fail the thing it observes.
  }
}

/**
 * The 500 a REST route returns from its catch block, recorded on the way out.
 * Replaces the bare `NextResponse.json({ error: humanError(e) }, { status: 500 })`
 * that every /api/v1 route used to build itself.
 */
export function apiFailure(request: Request, error: unknown): NextResponse {
  recordApiFailure(request, error, 500);
  return NextResponse.json({ error: humanError(error) }, { status: 500 });
}
