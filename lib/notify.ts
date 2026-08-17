// ==================================================================
// Operator alerts.
//
// One address, set by whoever runs the deployment, told when something happens
// that a person should know about. Today that is a signup; the shape is
// deliberately general because the second use always arrives.
//
// Both settings are optional and the whole thing no-ops without them, the same
// way the trial keys do. That matters more than it sounds: an alert is a
// courtesy, and a courtesy must never be able to break the thing it reports on.
// A signup that fails because a mail provider is rate-limiting is a worse
// outcome than an unsent email, so nothing in here throws.
//
// Transport is Resend over plain fetch — no SDK, matching how this codebase
// talks to every other HTTP API. Swapping providers is the `send` function
// below and nothing else.
// ==================================================================

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface AdminAlert {
  subject: string;
  /** Plain text. Kept plain on purpose: these are read on a phone. */
  body: string;
}

/**
 * Who gets operator alerts, if anyone.
 *
 * Comma-separated, parsed the same way as the admin allowlists in lib/admin.ts.
 * A single address is still the common case and still works unchanged — the
 * variable keeps its singular name so existing deployments need no edit.
 *
 * Empty means nobody, which is the normal state for a self-hoster who doesn't
 * want alerts.
 */
export function adminAlertEmails(): string[] {
  return (process.env.ADMIN_ALERT_EMAIL ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

/** The address alerts are sent FROM. Must be on a domain verified with the mail
 *  provider, which is why it is configurable rather than derived. */
function alertFrom(): string {
  const v = process.env.ADMIN_ALERT_FROM;
  return v && v.trim() ? v.trim() : "Lettertrace <onboarding@resend.dev>";
}

export type AlertOutcome = "sent" | "not-configured" | "failed";

/**
 * Send an operator alert. Never throws, and never blocks anything important —
 * callers should hand this to waitUntil rather than await it on a request path.
 *
 * Returns what happened so a caller can log it, but a caller that ignores the
 * result is also correct.
 */
export async function sendAdminAlert(alert: AdminAlert): Promise<AlertOutcome> {
  const to = adminAlertEmails();
  const apiKey = process.env.RESEND_API_KEY?.trim();

  // Unconfigured is the normal state for a self-hosted deployment that doesn't
  // want alerts, so it is not an error and not worth logging on every signup.
  if (to.length === 0 || !apiKey) return "not-configured";

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: alertFrom(),
        // One request with several recipients rather than one request each:
        // Resend takes an array, and a partial failure across N sends is a
        // worse thing to reason about than a single all-or-nothing result.
        to,
        subject: alert.subject,
        text: alert.body,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Body, not just status: a Resend rejection explains itself ("domain not
      // verified", "invalid to address") and that text is the whole diagnosis.
      const detail = await res.text().catch(() => "");
      console.error(`[notify] alert not sent (${res.status}): ${detail.slice(0, 300)}`);
      return "failed";
    }
    return "sent";
  } catch (e) {
    console.error(`[notify] alert not sent: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}

/**
 * Run something after the response, without letting it delay or break the
 * request. Uses waitUntil where the runtime provides it — a server component
 * render is not a context where that is guaranteed — and otherwise lets the
 * promise run detached. Either way the caller never waits and never throws.
 */
export function fireAndForget(work: Promise<unknown>): void {
  const swallowed = work.catch((e) => {
    console.error(`[notify] background work failed: ${e instanceof Error ? e.message : String(e)}`);
  });
  try {
    // Imported lazily: on a runtime without it, the require itself is the thing
    // that fails, and the fallback below is still correct.
    const { waitUntil } = require("@vercel/functions") as { waitUntil: (p: Promise<unknown>) => void };
    waitUntil(swallowed);
  } catch {
    void swallowed;
  }
}

/** The signup alert's wording, separated so it can be asserted without a
 *  network call and read without digging through the callback. */
export function signupAlert(user: { email?: string | null; id: string; created_at?: string }): AdminAlert {
  const who = user.email?.trim() || "(no email on the account)";
  return {
    subject: `New Lettertrace signup: ${who}`,
    body: [
      `${who} just created an account.`,
      "",
      `User id: ${user.id}`,
      user.created_at ? `Signed up: ${user.created_at}` : "",
      "",
      "They have not necessarily run anything yet — this fires when the account",
      "is confirmed and first signed in.",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  };
}
