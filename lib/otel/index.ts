import { SpanStatusCode, metrics, trace, type Attributes, type Span } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

/**
 * Hand-instrumentation helpers. This module imports only @opentelemetry/api,
 * which is a no-op until instrumentation.ts registers a provider — so it is
 * safe to import from anywhere, including code that also runs on the edge
 * runtime or in tests, and safe on a self-hosted install that never configures
 * an exporter.
 *
 * THE CONTENT RULE APPLIES HERE, and it is the same one lib/ops.ts states:
 * provider, model, route, counts and durations may be recorded. Prompt text,
 * answers, brand names and customer domains may NOT. Spans leave this
 * deployment; this is a public repository and an operator's data.
 */

const SCOPE = "lettertrace";

export function tracer() {
  return trace.getTracer(SCOPE);
}

// Instruments are created on first use rather than at module load. The global
// meter provider is a no-op until register() has run, and an instrument taken
// from the no-op provider stays a no-op for the life of the process.
let cached: {
  providerDuration: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]>;
  providerTokens: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
  runDuration: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]>;
  runResponses: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
} | null = null;

function instruments() {
  if (cached) return cached;
  const meter = metrics.getMeter(SCOPE);
  cached = {
    providerDuration: meter.createHistogram("lettertrace.provider.request.duration", {
      description: "Time for one answer-engine call, from request to parsed answer",
      unit: "ms",
    }),
    providerTokens: meter.createCounter("lettertrace.provider.tokens", {
      description: "Provider tokens consumed by answer-engine calls",
      unit: "{token}",
    }),
    runDuration: meter.createHistogram("lettertrace.run.duration", {
      description: "Wall time of one monitoring run, all prompts and engines",
      unit: "ms",
    }),
    runResponses: meter.createCounter("lettertrace.run.responses", {
      description: "Answers stored by monitoring runs",
      unit: "{response}",
    }),
  };
  return cached;
}

export function recordProviderCall(durationMs: number, tokens: number, attrs: Attributes): void {
  const i = instruments();
  i.providerDuration.record(durationMs, attrs);
  if (tokens > 0) i.providerTokens.add(tokens, attrs);
}

export function recordRun(durationMs: number, responses: number, attrs: Attributes): void {
  const i = instruments();
  i.runDuration.record(durationMs, attrs);
  if (responses > 0) i.runResponses.add(responses, attrs);
}

/**
 * Run `fn` inside a span, recording the exception and Error status on the way
 * out. The span is named from a fixed vocabulary by its callers — never from a
 * run id, a prompt or a domain — so span names stay low-cardinality.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        // The message class, not the occurrence — same reasoning as
        // signatureOf() in lib/ops.ts, and never any content.
        message: err instanceof Error ? err.name : "Error",
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

const SEVERITY = {
  info: { number: SeverityNumber.INFO, text: "INFO" },
  warn: { number: SeverityNumber.WARN, text: "WARN" },
  error: { number: SeverityNumber.ERROR, text: "ERROR" },
} as const;

/**
 * Mirror one operational event out as an OTel log record. Called from
 * lib/ops.ts so the existing recordOps / recordOpsError call sites are the
 * only ones anybody has to remember, and so the exported stream inherits the
 * signature scrubbing rather than re-implementing it.
 *
 * Never throws: rule 1 of lib/ops.ts.
 */
export function emitOpsLog(
  kind: string,
  level: keyof typeof SEVERITY,
  signature: string,
  attributes: Attributes,
): void {
  try {
    const severity = SEVERITY[level] ?? SEVERITY.info;
    logs.getLogger(SCOPE).emit({
      severityNumber: severity.number,
      severityText: severity.text,
      body: `${kind}: ${signature}`,
      attributes: { "ops.kind": kind, "ops.signature": signature, ...attributes },
    });
  } catch {
    // A telemetry pipeline must not be able to fail the thing it observes.
  }
}
