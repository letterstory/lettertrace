import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { sendAdminAlert, signupAlert, adminAlertEmail } from "@/lib/notify";
import { alertNewSignup } from "@/lib/notify-signup";

const ENV = ["ADMIN_ALERT_EMAIL", "ADMIN_ALERT_FROM", "RESEND_API_KEY"] as const;
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

describe("sendAdminAlert", () => {
  // The normal state for a self-hosted deployment that doesn't want alerts.
  // It must be silent and free — not an error, and not a wasted round trip.
  it("does nothing without an address or a key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await sendAdminAlert({ subject: "s", body: "b" })).toBe("not-configured");

    process.env.ADMIN_ALERT_EMAIL = "mathew@letterstory.com";
    expect(await sendAdminAlert({ subject: "s", body: "b" })).toBe("not-configured");

    delete process.env.ADMIN_ALERT_EMAIL;
    process.env.RESEND_API_KEY = "re_x";
    expect(await sendAdminAlert({ subject: "s", body: "b" })).toBe("not-configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts the alert to the configured address", async () => {
    process.env.ADMIN_ALERT_EMAIL = "mathew@letterstory.com";
    process.env.RESEND_API_KEY = "re_x";
    process.env.ADMIN_ALERT_FROM = "Lettertrace <alerts@letterstory.com>";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    expect(await sendAdminAlert({ subject: "New signup", body: "hello" })).toBe("sent");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("api.resend.com");
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent).toMatchObject({
      to: ["mathew@letterstory.com"],
      from: "Lettertrace <alerts@letterstory.com>",
      subject: "New signup",
      text: "hello",
    });
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer re_x" });
  });

  // An alert is a courtesy. It must never be able to break the thing it reports
  // on, so every failure path returns rather than throws.
  it("swallows a provider rejection", async () => {
    process.env.ADMIN_ALERT_EMAIL = "m@x.com";
    process.env.RESEND_API_KEY = "re_x";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("domain not verified", { status: 403 }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sendAdminAlert({ subject: "s", body: "b" })).toBe("failed");
  });

  it("swallows a network failure", async () => {
    process.env.ADMIN_ALERT_EMAIL = "m@x.com";
    process.env.RESEND_API_KEY = "re_x";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sendAdminAlert({ subject: "s", body: "b" })).toBe("failed");
  });

  it("reads the address from the environment", () => {
    expect(adminAlertEmail()).toBeNull();
    process.env.ADMIN_ALERT_EMAIL = "  mathew@letterstory.com  ";
    expect(adminAlertEmail()).toBe("mathew@letterstory.com");
  });
});

describe("signupAlert", () => {
  it("names the person in the subject, where a phone shows it", () => {
    const alert = signupAlert({ id: "u-1", email: "new@customer.com" });
    expect(alert.subject).toBe("New Lettertrace signup: new@customer.com");
    expect(alert.body).toContain("new@customer.com");
    expect(alert.body).toContain("u-1");
  });

  it("says so rather than printing 'undefined' for an account with no email", () => {
    const alert = signupAlert({ id: "u-2", email: null });
    expect(alert.subject).toContain("no email");
    expect(alert.body).not.toContain("undefined");
  });
});

describe("alertNewSignup", () => {
  /** A profiles table that honours the `is null` guard, the way Postgres does. */
  function fakeDb(alreadyAlerted: boolean, failWith?: string) {
    const filters: [string, unknown][] = [];
    const db = {
      from: () => ({
        update: () => {
          const chain = {
            eq: (c: string, v: unknown) => {
              filters.push([c, v]);
              return chain;
            },
            is: (c: string, v: unknown) => {
              filters.push([c, v]);
              return chain;
            },
            // The guard: no rows change when the stamp is already set.
            select: async () =>
              failWith
                ? { data: null, error: { message: failWith, code: "42703" } }
                : { data: alreadyAlerted ? [] : [{ id: "u-1" }], error: null },
          };
          return chain;
        },
      }),
    };
    return { db: db as never, filters };
  }

  it("does not touch the database when alerting is switched off", async () => {
    const { db, filters } = fakeDb(false);
    expect(await alertNewSignup(db, { id: "u-1", email: "a@b.com" })).toBe("not-configured");
    expect(filters).toHaveLength(0);
  });

  it("claims the alert with a guarded write, then sends", async () => {
    process.env.ADMIN_ALERT_EMAIL = "mathew@letterstory.com";
    process.env.RESEND_API_KEY = "re_x";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const { db, filters } = fakeDb(false);

    expect(await alertNewSignup(db, { id: "u-1", email: "a@b.com" })).toBe("alerted");
    // Scoped to the user AND to the not-yet-alerted state — that pair is what
    // makes a concurrent second callback a no-op.
    expect(filters).toContainEqual(["id", "u-1"]);
    expect(filters).toContainEqual(["admin_alerted_at", null]);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  // A confirmation link opened twice — by the person and by their mail client's
  // link scanner — is the ordinary case, not the exotic one.
  // The failure that would otherwise be invisible: a deployment running an
  // older schema has no admin_alerted_at column, every claim errors, and reading
  // that as "already claimed" would mean alerts silently never fire again.
  it("reports a failed claim rather than mistaking it for a duplicate", async () => {
    process.env.ADMIN_ALERT_EMAIL = "mathew@letterstory.com";
    process.env.RESEND_API_KEY = "re_x";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb(false, "column profiles.admin_alerted_at does not exist");

    expect(await alertNewSignup(db, { id: "u-1", email: "a@b.com" })).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends nothing when another request already claimed it", async () => {
    process.env.ADMIN_ALERT_EMAIL = "mathew@letterstory.com";
    process.env.RESEND_API_KEY = "re_x";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { db } = fakeDb(true);

    expect(await alertNewSignup(db, { id: "u-1", email: "a@b.com" })).toBe("already-alerted");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
