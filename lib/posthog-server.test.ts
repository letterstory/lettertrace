import { afterEach, describe, expect, it, vi } from "vitest";
import { computeEntityStats } from "@/lib/metrics";
import type { Mention } from "@/lib/types";
import {
  analyticsDistinctId,
  brandShareOfVoice,
  captureServerEvent,
  captureTrialLimit,
  posthogEnvironment,
  runTrigger,
  submittedDomain,
  trialLimitProperties,
  usdFromMicros,
} from "@/lib/posthog-server";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mention(partial: Pick<Mention, "entity_type" | "entity_name" | "mention_count" | "response_id">): Mention {
  return {
    id: partial.response_id + partial.entity_name,
    run_id: "run",
    project_id: "proj",
    topic_id: null,
    competitor_id: partial.entity_type === "competitor" ? "c1" : null,
    mentioned: true,
    first_position: 0.5,
    sentiment: "neutral",
    recommended: false,
    created_at: "2026-10-02T00:00:00.000Z",
    ...partial,
  };
}

describe("captureServerEvent", () => {
  it("sends the capture body PostHog's ingest API stores", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://eu.i.posthog.com/";
    process.env.VERCEL_ENV = "preview";
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await captureServerEvent("user-1", "org_created", {
      org_id: "org-1",
      billing_owner_id: "owner-1",
      channel: "dashboard",
      source: "manual",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // Trailing slash on the host must not produce a double slash. An EU
    // project pointed at the US host stores nothing and still answers 200.
    expect(url).toBe("https://eu.i.posthog.com/i/v0/e/");
    const body = JSON.parse(String(init?.body));
    expect(body.api_key).toBe("phc_test");
    expect(body.event).toBe("org_created");
    expect(body.distinct_id).toBe("user-1");
    expect(body.properties).toMatchObject({
      environment: "preview",
      org_id: "org-1",
      billing_owner_id: "owner-1",
      channel: "dashboard",
      source: "manual",
    });
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(posthogEnvironment()).toBe("preview");
  });

  it("sends nothing when the key is unset, which is every self-hosted install", async () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await captureServerEvent("user-1", "org_created", {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not throw when PostHog is down, returns 500, or times out", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(new Response("no", { status: 500 }))
      .mockRejectedValueOnce(new DOMException("The operation was aborted", "TimeoutError"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(captureServerEvent("user-1", "run_triggered", {})).resolves.toBeUndefined();
    await expect(captureServerEvent("user-1", "run_triggered", {})).resolves.toBeUndefined();
    await expect(captureServerEvent("user-1", "run_triggered", {})).resolves.toBeUndefined();
  });

  it("labels a machine with no VERCEL_ENV as development", () => {
    delete process.env.VERCEL_ENV;
    expect(posthogEnvironment()).toBe("development");
  });
});

describe("who an event belongs to", () => {
  it("uses the teammate who clicked, and the owner when nobody did", () => {
    expect(analyticsDistinctId("owner", { actorType: "user", actorId: "teammate" })).toBe("teammate");
    // An API key's actorId is the key. The account is userId.
    expect(
      analyticsDistinctId("owner", { actorType: "api_key", actorId: "key-1", userId: "caller" }),
    ).toBe("caller");
    expect(analyticsDistinctId("owner", { actorType: "cron", actorId: "scheduler" })).toBe("owner");
  });

  it("names onboarding and the scheduler, and treats every other ask as manual", () => {
    expect(runTrigger({ trigger: "onboarding" })).toBe("onboarding");
    expect(runTrigger({ channel: "cron" })).toBe("scheduled");
    expect(runTrigger({ channel: "dashboard", actorType: "user" })).toBe("manual");
  });
});

describe("trial_limit_reached properties", () => {
  it("records which ceiling was hit, and the numbers on both of them", () => {
    expect(
      trialLimitProperties(
        { exhaustedBy: "spend", limit: 15, remaining: 12, spentMicros: 5_000_000, capMicros: 5_000_000 },
        "manual",
      ),
    ).toEqual({
      limit_type: "spend",
      runs_used: 3,
      run_limit: 15,
      spend_used_usd: 5,
      spend_limit_usd: 5,
      trigger: "manual",
    });
    expect(
      trialLimitProperties({ exhaustedBy: "runs", limit: 1, remaining: 0, spentMicros: 100_000, capMicros: 5_000_000 }, "scheduled"),
    ).toMatchObject({ limit_type: "runs", runs_used: 1, run_limit: 1, trigger: "scheduled" });
  });

  it("counts the allowance as used when the atomic take loses the race", () => {
    expect(
      trialLimitProperties({ limit: 15, remaining: 1, spentMicros: 0, capMicros: 1_000_000 }, "onboarding", true),
    ).toMatchObject({ limit_type: "runs", runs_used: 15, trigger: "onboarding" });
  });

  it("is not sent for a comped account", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    await captureTrialLimit({
      distinctId: "owner-1",
      billingOwnerId: "owner-1",
      orgId: "org-1",
      channel: "cron",
      trigger: "scheduled",
      key: { exhaustedBy: "runs", limit: 1, remaining: 0 },
      compedAccount: true,
    });
    await captureTrialLimit({
      distinctId: "owner-1",
      billingOwnerId: "owner-1",
      channel: "dashboard",
      trigger: "manual",
      key: { comped: true, exhaustedBy: "runs", limit: 1, remaining: 0 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("what is allowed to leave", () => {
  it("keeps only the host of a submitted URL", () => {
    expect(submittedDomain("https://www.Acme.com/pricing")).toBe("acme.com");
  });

  it("prices micro-dollars as dollars", () => {
    expect(usdFromMicros(1_500_000)).toBe(1.5);
    expect(usdFromMicros(undefined)).toBe(0);
  });

  it("matches the report's share of voice for the same mentions", () => {
    const mentions = [
      mention({ entity_type: "brand", entity_name: "Acme", mention_count: 2, response_id: "r1" }),
      mention({ entity_type: "brand", entity_name: "Acme", mention_count: 1, response_id: "r2" }),
      mention({ entity_type: "competitor", entity_name: "Rival", mention_count: 3, response_id: "r1" }),
    ];
    const stats = computeEntityStats(mentions, 4, "Acme");
    const brand = stats.find((s) => s.type === "brand");
    expect(brandShareOfVoice(3, 3)).toBe(brand?.shareOfVoice);
    expect(brandShareOfVoice(0, 0)).toBe(0);
  });
});
