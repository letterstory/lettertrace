import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cardinalSignupConfigured,
  sendCardinalSignup,
  withinCardinalSignupWindow,
  type CardinalSignupOutcome,
} from "@/lib/cardinal-signup";

/** A user who just signed up, for tests that aren't exercising the age check itself. */
const NEW_USER = { created_at: new Date().toISOString() };

const ENV = ["CARDINAL_SIGNUP_WEBHOOK_URL", "CARDINAL_SIGNUP_WEBHOOK_TOKEN"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function configureCardinal() {
  process.env.CARDINAL_SIGNUP_WEBHOOK_URL =
    "https://webhooks.trycardinal.ai/product-signup/webhook/lettertrace.com";
  process.env.CARDINAL_SIGNUP_WEBHOOK_TOKEN = "rotated-token";
}

/** A profiles table that honours the `is null` guard, the way Postgres does. */
function fakeDb(alreadySent: boolean, failWith?: string) {
  const filters: [string, unknown][] = [];
  const updates: Record<string, unknown>[] = [];
  const db = {
    from: () => ({
      update: (values: Record<string, unknown>) => {
        updates.push(values);
        const chain = {
          eq: (c: string, v: unknown) => {
            filters.push([c, v]);
            return chain;
          },
          is: (c: string, v: unknown) => {
            filters.push([c, v]);
            return chain;
          },
          select: async () =>
            failWith
              ? { data: null, error: { message: failWith, code: "42703" } }
              : { data: alreadySent ? [] : [{ id: "u-1" }], error: null },
        };
        return chain;
      },
    }),
  };
  return { db: db as never, filters, updates };
}

describe("cardinalSignupConfigured", () => {
  it("requires both the URL and token", () => {
    expect(cardinalSignupConfigured()).toBe(false);
    process.env.CARDINAL_SIGNUP_WEBHOOK_URL = "https://example.com/webhook";
    expect(cardinalSignupConfigured()).toBe(false);
    delete process.env.CARDINAL_SIGNUP_WEBHOOK_URL;
    process.env.CARDINAL_SIGNUP_WEBHOOK_TOKEN = "token";
    expect(cardinalSignupConfigured()).toBe(false);
    configureCardinal();
    expect(cardinalSignupConfigured()).toBe(true);
  });
});

describe("withinCardinalSignupWindow", () => {
  const NOW = Date.parse("2026-09-10T00:00:00Z");
  const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

  it("accepts an account created moments ago", () => {
    expect(withinCardinalSignupWindow(daysAgo(0), NOW)).toBe(true);
  });

  it("rejects an account older than the window", () => {
    expect(withinCardinalSignupWindow(daysAgo(2), NOW)).toBe(false);
  });

  it("rejects a missing or unparseable timestamp rather than defaulting to new", () => {
    expect(withinCardinalSignupWindow(undefined, NOW)).toBe(false);
    expect(withinCardinalSignupWindow("not a date", NOW)).toBe(false);
  });
});

describe("sendCardinalSignup", () => {
  it("never touches the database for an account that predates this column", async () => {
    // Regression test: the migration adds cardinal_signup_sent_at with no
    // backfill, so every pre-existing account starts out NULL too. Caught
    // manually when restarting the dev server fired the webhook for a
    // two-day-old account on a plain dashboard reload.
    configureCardinal();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { db, filters, updates } = fakeDb(false);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    expect(
      await sendCardinalSignup(db, { id: "u-1", email: "a@b.com", created_at: twoDaysAgo }),
    ).toBe("too-old");
    expect(filters).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not touch the database or network when unconfigured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { db, filters, updates } = fakeDb(false);

    expect(await sendCardinalSignup(db, { id: "u-1", email: "a@b.com", ...NEW_USER })).toBe(
      "not-configured" satisfies CardinalSignupOutcome,
    );
    expect(filters).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips accounts with no email", async () => {
    configureCardinal();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { db, filters, updates } = fakeDb(false);

    expect(await sendCardinalSignup(db, { id: "u-1", email: "  ", ...NEW_USER })).toBe(
      "no-email",
    );
    expect(filters).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("claims the signup, then posts email + company to Cardinal for a work address", async () => {
    configureCardinal();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const { db, filters, updates } = fakeDb(false);

    expect(
      await sendCardinalSignup(db, { id: "u-1", email: " New@Customer.COM ", ...NEW_USER }),
    ).toBe("sent");
    expect(updates[0]).toHaveProperty("cardinal_signup_sent_at");
    expect(filters).toContainEqual(["id", "u-1"]);
    expect(filters).toContainEqual(["cardinal_signup_sent_at", null]);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(process.env.CARDINAL_SIGNUP_WEBHOOK_URL);
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer rotated-token",
    });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      email: "new@customer.com",
      company: "Customer",
    });
  });

  it("omits company for a personal address, and omits name fields when not given", async () => {
    configureCardinal();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const { db } = fakeDb(false);

    expect(await sendCardinalSignup(db, { id: "u-1", email: "a@gmail.com", ...NEW_USER })).toBe(
      "sent",
    );
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ email: "a@gmail.com" });
  });

  it("includes first_name/last_name when the caller has them", async () => {
    configureCardinal();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const { db } = fakeDb(false);

    expect(
      await sendCardinalSignup(db, {
        id: "u-1",
        email: "a@gmail.com",
        first_name: " Sam ",
        last_name: " Rivera ",
        ...NEW_USER,
      }),
    ).toBe("sent");
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      email: "a@gmail.com",
      first_name: "Sam",
      last_name: "Rivera",
    });
  });

  it("sends nothing when another request already claimed it", async () => {
    configureCardinal();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { db } = fakeDb(true);

    expect(await sendCardinalSignup(db, { id: "u-1", email: "a@b.com", ...NEW_USER })).toBe(
      "already-sent",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports a failed claim rather than treating an older schema as sent", async () => {
    configureCardinal();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb(false, "column profiles.cardinal_signup_sent_at does not exist");

    expect(await sendCardinalSignup(db, { id: "u-1", email: "a@b.com", ...NEW_USER })).toBe("failed");
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("swallows a Cardinal rejection", async () => {
    configureCardinal();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad token", { status: 401 }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb(false);

    expect(await sendCardinalSignup(db, { id: "u-1", email: "a@b.com", ...NEW_USER })).toBe("failed");
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("swallows a network failure", async () => {
    configureCardinal();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb(false);

    expect(await sendCardinalSignup(db, { id: "u-1", email: "a@b.com", ...NEW_USER })).toBe("failed");
    expect(errorSpy).toHaveBeenCalledOnce();
  });
});
