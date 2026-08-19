/**
 * The founder-call offer: a one-time nudge, shortly after signup, asking
 * whether the user wants a walkthrough with the founder.
 *
 * Off unless `FOUNDER_CALL_URL` is set, in the same spirit as PostHog and the
 * RB2B pixel. That is not a stylistic choice — this repo ships as a
 * self-hostable container, and an operator running their own Lettertrace must
 * never have their users offered a meeting with *our* founder. Unset means the
 * feature does not exist, not that it is merely hidden.
 *
 * Deliberately NOT `NEXT_PUBLIC_`, unlike those two. Next inlines that prefix
 * into the client bundle at BUILD time (see lib/public-env.ts, which exists
 * entirely because of that behaviour), and this repo publishes a prebuilt
 * image. A public-prefixed name would bake whatever we built with into every
 * operator's container. This value is only ever read on the server and reaches
 * the browser as a prop, so it never needs to be public — which sidesteps the
 * whole problem rather than working around it.
 *
 * The window exists so the offer reaches new signups and nobody else. Without
 * it, shipping this would show a "need help getting started?" dialog to every
 * existing user on their next visit, which is a different (and unasked-for)
 * campaign. Seven days rather than "this session" because signing up and
 * actually coming back to try it are frequently not the same day.
 */

export const FOUNDER_CALL_WINDOW_DAYS = 7;

/** How long after arriving before the offer appears. */
export const FOUNDER_CALL_DELAY_MS = 30_000;

export function founderCallUrl(): string | null {
	return process.env.FOUNDER_CALL_URL || null;
}

/**
 * Tags the booking link so a booking that came from this dialog can be told
 * apart from one that came from a DM, the site, or a conference badge.
 *
 * Cal.com reads `metadata[key]=value` off the URL, stores it on the booking row
 * and passes it through to webhooks. It is invisible to the person booking,
 * which is what makes it honest attribution rather than a message: it records
 * where the click came from and does not put words in their mouth.
 *
 * What this CANNOT do is change what the invite says. A Cal event's title,
 * description and duration live on the event type, not the URL — so making the
 * meeting read "Lettertrace setup call" is a change on Cal's side, not here.
 * Because the link is an env var, swapping to a dedicated event type needs no
 * deploy.
 *
 * Any query string already on the configured URL is preserved, so pointing
 * FOUNDER_CALL_URL at a link that carries its own parameters keeps working.
 * An unparseable URL is returned untouched rather than dropped — a booking link
 * that works is worth more than attribution.
 */
export const FOUNDER_CALL_SOURCE = "lettertrace-dashboard";

/** Same link on the marketing page — a booking from there is a different funnel. */
export const FOUNDER_CALL_LANDING_SOURCE = "lettertrace-landing";

export function taggedBookingUrl(base: string, source = FOUNDER_CALL_SOURCE): string {
	try {
		const url = new URL(base);
		url.searchParams.set("metadata[source]", source);
		return url.toString();
	} catch {
		return base;
	}
}

/**
 * Is this account new enough to be offered a founder call?
 *
 * Returns false for an unparseable or missing timestamp rather than defaulting
 * to true: the failure mode of guessing "new" is prompting someone who signed
 * up a year ago, and the offer is not repeatable, so a wrong yes is spent.
 */
export function withinSignupWindow(createdAt: string | undefined, now = Date.now()): boolean {
	if (!createdAt) return false;
	const created = Date.parse(createdAt);
	if (Number.isNaN(created)) return false;
	const age = now - created;
	// A clock-skewed future timestamp is still a new account, not an old one.
	return age < FOUNDER_CALL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * The whole server-side decision, as a pure function so it can be tested
 * without a database or a browser.
 */
export function shouldOfferFounderCall(input: {
	url: string | null;
	createdAt: string | undefined;
	promptedAt: string | null | undefined;
	now?: number;
}): boolean {
	if (!input.url) return false;
	// Already asked. Null is "never asked"; undefined means we could not read
	// the row, and an unreadable row must not be treated as never — that would
	// re-offer on every render for as long as the read keeps failing.
	if (input.promptedAt !== null) return false;
	return withinSignupWindow(input.createdAt, input.now);
}
