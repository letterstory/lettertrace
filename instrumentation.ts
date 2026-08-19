/**
 * Next.js instrumentation hook — the one place OpenTelemetry is started.
 *
 * Two guards, both load-bearing:
 *
 *   1. `NEXT_RUNTIME === "nodejs"`. This module is evaluated in every runtime
 *      Next builds for, and the Node SDK cannot run on the edge runtime. The
 *      exporters are therefore behind a dynamic import rather than a top-level
 *      one — a static import would be bundled into the edge build and fail
 *      there before this check ever ran.
 *
 *   2. An endpoint must be configured. This repository is public and ships a
 *      prebuilt self-hostable image, so telemetry follows the same rule as
 *      OPS_TELEMETRY in lib/ops.ts: a self-hosted install exports nothing until
 *      its operator asks for it. Unset endpoint means no SDK, no exporter, and
 *      no outbound connection.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;

  const { registerOtel } = await import("@/lib/otel/register");
  registerOtel();
}
