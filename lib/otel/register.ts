import { registerOTel } from "@vercel/otel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { RedactFetchUrls } from "./redact-fetch";

/**
 * Start the OpenTelemetry SDK. Node runtime only — see instrumentation.ts for
 * the guards, which are the reason this file is imported dynamically.
 *
 * Everything backend-specific lives in environment variables, not here:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT   root URL, no /v1/... suffix
 *   OTEL_EXPORTER_OTLP_HEADERS    e.g. Authorization=Bearer <token>
 *   OTEL_EXPORTER_OTLP_PROTOCOL   http/protobuf
 *   OTEL_SERVICE_NAME             defaults to "lettertrace" below
 *
 * The three exporters read those variables themselves, so pointing this app at
 * a different OTLP backend is a deployment change and never a code change.
 */
export function registerOtel(): void {
  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME || "lettertrace",

    attributes: {
      // @vercel/otel sets service.version to the Vercel DEPLOYMENT ID, which
      // is unique per build and says nothing about what code is running.
      // The commit sha is what makes "did that change do it?" a group-by
      // instead of a guess, so it wins where one is available.
      ...(process.env.VERCEL_GIT_COMMIT_SHA
        ? { "service.version": process.env.VERCEL_GIT_COMMIT_SHA }
        : {}),
    },

    // Vercel freezes a function the moment its response is sent, so a batch
    // that has not left the process is lost. @vercel/otel flushes the trace
    // and log processors at the end of each invocation; the metric reader is
    // pulled on its own clock, hence an interval short enough that a daily
    // cron run reports more than once.
    traceExporter: new OTLPTraceExporter(),

    // "auto" keeps @vercel/otel's own export processor; RedactFetchUrls runs
    // ahead of it and takes the request URL out of the outbound fetch spans it
    // creates. See ./redact-fetch.ts for what was riding along in them.
    spanProcessors: [new RedactFetchUrls(), "auto"],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 15_000,
      }),
    ],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
  });
}
