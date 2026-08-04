import { describe, it, expect, afterEach, vi } from "vitest";

// admin.ts reads the signed-in user through the cookie client, which calls
// React's cache() at module load — unavailable in the node test env. Only the
// pure allowlist helpers are under test here.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
import { signatureOf, opsEnabled } from "@/lib/ops";
import { shapeOps, type OpsRow } from "@/lib/ops-report";
import { shapeLive } from "@/lib/ops-live";
import { configChecks, configProblems } from "@/lib/ops-config";
import { isAdminEmail, adminEmails } from "@/lib/admin";

const HOUR = "2026-08-03T14:00:00.000Z";

function opsRow(over: Partial<OpsRow> = {}): OpsRow {
  return {
    kind: "run.completed",
    level: "info",
    signature: "run.completed:anthropic/claude-opus-5",
    hour: HOUR,
    occurrences: 1,
    sample: {},
    last_seen_at: HOUR,
    ...over,
  };
}

describe("signatureOf", () => {
  it("collapses occurrences of the same problem into one signature", () => {
    const a = signatureOf("run 4f3c9a21-1111-2222-3333-444455556666 failed after 12.5s");
    const b = signatureOf("run 9999aaaa-bbbb-cccc-dddd-eeeeffff0000 failed after 3s");
    // The whole bucketing design rests on this: if ids or durations survived,
    // every occurrence would open its own row and the count would always be 1.
    expect(a).toBe(b);
  });

  it("keeps genuinely different problems apart", () => {
    expect(signatureOf("rate limit exceeded")).not.toBe(signatureOf("invalid api key"));
  });

  it("strips quoted values, which are usually the varying part", () => {
    expect(signatureOf(`model "gpt-4" not found`)).toBe(signatureOf(`model "gemini-pro" not found`));
  });

  it("bounds the length so a stack trace cannot become a signature", () => {
    expect(signatureOf("x".repeat(5000)).length).toBeLessThanOrEqual(200);
  });
});

describe("opsEnabled", () => {
  const original = process.env.OPS_TELEMETRY;
  afterEach(() => {
    if (original === undefined) delete process.env.OPS_TELEMETRY;
    else process.env.OPS_TELEMETRY = original;
  });

  it("is off unless explicitly switched on", () => {
    delete process.env.OPS_TELEMETRY;
    expect(opsEnabled()).toBe(false);
    // A self-hosted deployment must not start recording because someone set the
    // variable to something falsy-looking but non-empty.
    process.env.OPS_TELEMETRY = "0";
    expect(opsEnabled()).toBe(false);
    process.env.OPS_TELEMETRY = "false";
    expect(opsEnabled()).toBe(false);
    process.env.OPS_TELEMETRY = "1";
    expect(opsEnabled()).toBe(true);
  });
});

describe("shapeOps", () => {
  it("reports no success rate when nothing ran, rather than 100%", () => {
    const r = shapeOps([], 24, true);
    // The dangerous alternative: 0/0 rendered as a perfect score on a
    // deployment that is doing nothing at all.
    expect(r.runs.successRate).toBeNull();
  });

  it("sums occurrences across hourly buckets for the same problem", () => {
    const r = shapeOps(
      [
        opsRow({ kind: "error", level: "error", signature: "boom", occurrences: 30, hour: HOUR }),
        opsRow({
          kind: "error",
          level: "error",
          signature: "boom",
          occurrences: 12,
          hour: "2026-08-03T15:00:00.000Z",
          last_seen_at: "2026-08-03T15:30:00.000Z",
        }),
      ],
      24,
      true,
    );
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0].occurrences).toBe(42);
    expect(r.problems[0].lastSeen).toBe("2026-08-03T15:30:00.000Z");
  });

  it("ranks the loudest problem first", () => {
    const r = shapeOps(
      [
        opsRow({ kind: "error", level: "error", signature: "quiet", occurrences: 2 }),
        opsRow({ kind: "error", level: "error", signature: "loud", occurrences: 200 }),
      ],
      24,
      true,
    );
    expect(r.problems.map((p) => p.signature)).toEqual(["loud", "quiet"]);
  });

  it("counts only error rows as problems", () => {
    const r = shapeOps([opsRow({ level: "info", occurrences: 5 })], 24, true);
    expect(r.problems).toHaveLength(0);
    expect(r.errors).toBe(0);
  });

  it("survives a malformed sample without throwing", () => {
    const r = shapeOps([opsRow({ sample: null as never })], 24, true);
    expect(r.engines[0].engine).toBe("?/?");
  });
});

describe("shapeLive", () => {
  const now = new Date("2026-08-03T16:00:00.000Z").getTime();
  const run = (over: Record<string, unknown> = {}) => ({
    id: "aaaaaaaa-0000-0000-0000-000000000000",
    status: "completed",
    provider: "anthropic",
    model: "claude-opus-5",
    error: null,
    prompt_count: 10,
    completed_count: 10,
    started_at: "2026-08-03T15:50:00.000Z",
    created_at: "2026-08-03T15:50:00.000Z",
    ...over,
  });

  it("flags a run still running long past any plausible duration", () => {
    const r = shapeLive(
      [run({ status: "running", started_at: "2026-08-03T14:00:00.000Z", completed_count: 3 })],
      now,
      0,
      0,
      0,
    );
    expect(r.stuck).toHaveLength(1);
    expect(r.stuck[0].minutes).toBe(120);
  });

  it("does not flag a run that is merely slow", () => {
    const r = shapeLive([run({ status: "running", started_at: "2026-08-03T15:45:00.000Z" })], now, 0, 0, 0);
    expect(r.stuck).toHaveLength(0);
  });

  it("falls back to created_at when a pending run never started", () => {
    // A run that never got picked up has no started_at at all; using it
    // directly would produce NaN minutes and silently drop the row.
    const r = shapeLive(
      [run({ status: "pending", started_at: null, created_at: "2026-08-03T13:00:00.000Z" })],
      now,
      0,
      0,
      0,
    );
    expect(r.stuck).toHaveLength(1);
    expect(r.stuck[0].minutes).toBe(180);
  });

  it("groups failures by message shape and lists the engines involved", () => {
    const r = shapeLive(
      [
        run({ status: "failed", error: "rate limit exceeded, retry in 30s" }),
        run({ status: "failed", error: "rate limit exceeded, retry in 5s", model: "claude-sonnet-5" }),
        run({ status: "failed", error: "invalid api key" }),
      ],
      now,
      0,
      0,
      0,
    );
    expect(r.failures).toHaveLength(2);
    expect(r.failures[0].count).toBe(2);
    expect(r.failures[0].engines).toEqual(["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"]);
  });

  it("computes success rate from settled runs only", () => {
    const r = shapeLive(
      [run(), run(), run({ status: "failed", error: "x" }), run({ status: "running" })],
      now,
      0,
      0,
      0,
    );
    // 2 of 3 settled; the in-flight run is not evidence either way.
    expect(r.successRate).toBe(67);
    expect(r.runs24h.running).toBe(1);
  });

  it("separates per-engine health so a single bad provider is visible", () => {
    const r = shapeLive(
      [
        run({ provider: "openai", model: "gpt-5", status: "failed", error: "boom" }),
        run({ provider: "openai", model: "gpt-5", status: "failed", error: "boom" }),
        run(),
      ],
      now,
      0,
      0,
      0,
    );
    const openai = r.engines.find((e) => e.engine === "openai/gpt-5");
    expect(openai?.rate).toBe(0);
    expect(r.engines.find((e) => e.engine === "anthropic/claude-opus-5")?.rate).toBe(100);
  });

  it("carries a degraded reason so the page can say unknown instead of zero", () => {
    const r = shapeLive([], now, 0, 0, 0, "connection refused");
    expect(r.degraded).toBe("connection refused");
    expect(r.successRate).toBeNull();
  });
});

describe("configChecks", () => {
  it("marks a missing required setting as a problem", () => {
    const problems = configProblems(configChecks({ NEXT_PUBLIC_SUPABASE_URL: "https://x" } as never));
    expect(problems.map((p) => p.key)).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(problems.map((p) => p.key)).not.toContain("NEXT_PUBLIC_SUPABASE_URL");
  });

  it("treats whitespace as unset", () => {
    // Vercel happily stores a variable whose value is a stray space, and it
    // behaves exactly like a missing one everywhere else in the app.
    const checks = configChecks({ ENCRYPTION_KEY: "   " } as never);
    expect(checks.find((c) => c.key === "ENCRYPTION_KEY")?.state).toBe("missing");
  });

  it("never reports an optional setting as a problem", () => {
    const problems = configProblems(configChecks({} as never));
    expect(problems.every((p) => p.required)).toBe(true);
  });

  it("reports presence only, never any part of a value", () => {
    const secret = "sk-super-secret-value";
    const serialized = JSON.stringify(configChecks({ ENCRYPTION_KEY: secret } as never));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("sk-");
  });
});

describe("isAdminEmail", () => {
  const original = process.env.ADMIN_EMAILS;
  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = original;
  });

  it("admits nobody when the allowlist is unset", () => {
    delete process.env.ADMIN_EMAILS;
    expect(adminEmails()).toEqual([]);
    expect(isAdminEmail("anyone@example.com")).toBe(false);
  });

  it("admits nobody when the allowlist is empty or only separators", () => {
    process.env.ADMIN_EMAILS = " , , ";
    expect(isAdminEmail("anyone@example.com")).toBe(false);
    // The dangerous bug this guards: an empty split producing [""] and then
    // matching an empty-ish address.
    expect(isAdminEmail("")).toBe(false);
  });

  it("matches case-insensitively and ignores surrounding space", () => {
    process.env.ADMIN_EMAILS = " Casey@Letterstory.com , mathew@letterstory.com";
    expect(isAdminEmail("casey@letterstory.com")).toBe(true);
    expect(isAdminEmail("  MATHEW@letterstory.com ")).toBe(true);
  });

  it("does not match on substrings", () => {
    process.env.ADMIN_EMAILS = "casey@letterstory.com";
    expect(isAdminEmail("casey@letterstory.com.attacker.test")).toBe(false);
    expect(isAdminEmail("notcasey@letterstory.com")).toBe(false);
  });

  it("rejects null and undefined", () => {
    process.env.ADMIN_EMAILS = "casey@letterstory.com";
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
  });
});
