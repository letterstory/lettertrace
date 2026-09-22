// ==================================================================
// Outbound mail.
//
// Two kinds, one transport. OPERATOR ALERTS go to whoever runs the deployment
// when something happens that a person should know about (a signup). USER MAIL
// goes to somebody who is not us — today, a team invitation.
//
// The two differ in exactly one way that matters, and it is not the wording:
// an alert may silently not be sent, because it is a courtesy. An invitation
// may not, because a person is standing at the other end of it waiting for a
// link, and "invited!" followed by nothing is worse than an error. So sendMail
// reports what happened and the invite route refuses to claim success on
// anything but "sent" — see app/api/team/invites.
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

/** The address mail is sent FROM. Must be on a domain verified with the mail
 *  provider, which is why it is configurable rather than derived. Shared by
 *  alerts and user mail: a deployment has one verified sender. */
function alertFrom(): string {
  const v = process.env.ADMIN_ALERT_FROM;
  return v && v.trim() ? v.trim() : "Lettertrace <onboarding@resend.dev>";
}

export type AlertOutcome = "sent" | "not-configured" | "failed";

export interface Mail {
  to: string[];
  subject: string;
  /** Plain text. Kept plain on purpose: these are read on a phone. */
  body: string;
  /** Where a reply should go, when there is a human on our side of it. An
   *  invitation is from a person, so replying to it should reach them rather
   *  than a no-reply address nobody watches. */
  replyTo?: string;
}

/**
 * Put one message on the wire. The whole transport, and the only place this
 * codebase talks to a mail provider — swapping providers is this function and
 * nothing else.
 *
 * Never throws: it reports an outcome and lets the caller decide whether that
 * outcome matters. An alert ignores it; an invitation does not.
 */
export async function sendMail(mail: Mail): Promise<AlertOutcome> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const to = mail.to.map((address) => address.trim()).filter(Boolean);
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
        subject: mail.subject,
        text: mail.body,
        ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Body, not just status: a Resend rejection explains itself ("domain not
      // verified", "invalid to address") and that text is the whole diagnosis.
      const detail = await res.text().catch(() => "");
      console.error(`[notify] mail not sent (${res.status}): ${detail.slice(0, 300)}`);
      return "failed";
    }
    return "sent";
  } catch (e) {
    console.error(`[notify] mail not sent: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}

/**
 * Send an operator alert. Never throws, and never blocks anything important —
 * callers should hand this to waitUntil rather than await it on a request path.
 *
 * Returns what happened so a caller can log it, but a caller that ignores the
 * result is also correct.
 */
export async function sendAdminAlert(alert: AdminAlert): Promise<AlertOutcome> {
  // Unconfigured is the normal state for a self-hosted deployment that doesn't
  // want alerts, so it is not an error and not worth logging on every signup —
  // sendMail returns "not-configured" for it rather than complaining.
  return sendMail({ to: adminAlertEmails(), subject: alert.subject, body: alert.body });
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
      "They have not necessarily run anything yet: this fires when the account",
      "is confirmed and first signed in.",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  };
}

/**
 * The invitation email's wording, separated from the sending for the same
 * reason signupAlert is: it can be asserted without a network call, and read
 * without digging through a route.
 *
 * Names the inviter and the organization, because the first question anyone
 * asks of an unexpected invite is "who is this and what am I being added to",
 * and an email that can't answer it gets deleted. Says what accepting does and
 * what it doesn't — a teammate can read and run the project, and cannot see
 * the owner's API keys — because "join my workspace" is not enough information
 * to consent to.
 */
export function inviteEmail(args: {
  to: string;
  url: string;
  inviterEmail: string | null;
  organization: string;
  expiresAt: string;
}): Mail {
  const inviter = args.inviterEmail?.trim() || "Someone";
  return {
    to: [args.to],
    // Reply reaches the person who invited them, not a mailbox nobody watches.
    replyTo: args.inviterEmail?.trim() || undefined,
    subject: `${inviter} invited you to ${args.organization} on Lettertrace`,
    body: [
      `${inviter} has invited you to join "${args.organization}" on Lettertrace,`,
      "where teams track how AI assistants talk about their brand.",
      "",
      "Accept the invitation:",
      args.url,
      "",
      `The link expires ${new Date(args.expiresAt).toUTCString()} and works once.`,
      `It was sent to ${args.to} — you'll need to be signed in as that address`,
      "to accept, and you can create an account with it on the way through.",
      "",
      "As a team member you can see this organization's prompts, competitors,",
      "and results, and start runs. You cannot see the owner's API keys, and",
      "runs you start are paid for by the owner's account.",
      "",
      "If you weren't expecting this, you can ignore it — nothing happens until",
      "you click the link.",
    ].join("\n"),
  };
}
