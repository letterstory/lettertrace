import { describe, expect, it } from "vitest";
import { FOUNDER_CALL_WINDOW_DAYS, shouldOfferFounderCall, taggedBookingUrl, withinSignupWindow } from "./founder-call";

const NOW = Date.parse("2026-08-18T12:00:00Z");
const days = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

const CAL_LINK = "https://the-letter-company.cal.com/mathew";

describe("withinSignupWindow", () => {
	it("accepts an account created moments ago", () => {
		expect(withinSignupWindow(days(0), NOW)).toBe(true);
	});

	// Signing up and actually coming back to try it are frequently not the same
	// day, which is why the window is days rather than the session.
	it("accepts an account that comes back a few days later", () => {
		expect(withinSignupWindow(days(FOUNDER_CALL_WINDOW_DAYS - 1), NOW)).toBe(true);
	});

	it("rejects an account past the window", () => {
		expect(withinSignupWindow(days(FOUNDER_CALL_WINDOW_DAYS + 1), NOW)).toBe(false);
	});

	// The point of the window: shipping this must not fire a "need help getting
	// started?" dialog at the entire existing user base.
	it("rejects a long-established account", () => {
		expect(withinSignupWindow(days(400), NOW)).toBe(false);
	});

	/**
	 * A wrong "yes" is spent — the offer is made once and never repeats — so
	 * every unusable timestamp resolves to no.
	 */
	it("rejects a missing or unparseable timestamp rather than guessing", () => {
		expect(withinSignupWindow(undefined, NOW)).toBe(false);
		expect(withinSignupWindow("", NOW)).toBe(false);
		expect(withinSignupWindow("not a date", NOW)).toBe(false);
	});

	it("treats a clock-skewed future timestamp as new, not ancient", () => {
		expect(withinSignupWindow(days(-1), NOW)).toBe(true);
	});
});

describe("shouldOfferFounderCall", () => {
	const base = { url: CAL_LINK, createdAt: days(0), promptedAt: null, now: NOW };

	it("offers to a new user who has never been asked", () => {
		expect(shouldOfferFounderCall(base)).toBe(true);
	});

	/**
	 * The self-hosting guard. This repo ships as a container image, and an
	 * operator running their own Lettertrace must never have their users offered
	 * a meeting with our founder. Unset means the feature does not exist.
	 */
	it("is off entirely when no URL is configured", () => {
		expect(shouldOfferFounderCall({ ...base, url: null })).toBe(false);
		expect(shouldOfferFounderCall({ ...base, url: "" })).toBe(false);
	});

	it("never asks twice", () => {
		expect(shouldOfferFounderCall({ ...base, promptedAt: "2026-08-17T09:00:00Z" })).toBe(false);
	});

	/**
	 * An unreadable profile row yields undefined, and undefined must not read as
	 * "never asked" — that would re-offer on every single render for as long as
	 * the read keeps failing, which is the most annoying possible failure mode.
	 */
	it("stays quiet when the row could not be read at all", () => {
		expect(shouldOfferFounderCall({ ...base, promptedAt: undefined })).toBe(false);
	});

	it("does not offer to an established user, asked or not", () => {
		expect(shouldOfferFounderCall({ ...base, createdAt: days(30) })).toBe(false);
	});
});

describe("taggedBookingUrl", () => {
	it("tags the booking so it can be attributed to this dialog", () => {
		const u = new URL(taggedBookingUrl("https://the-letter-company.cal.com/mathew"));
		expect(u.searchParams.get("metadata[source]")).toBe("lettertrace-dashboard");
		expect(u.origin + u.pathname).toBe("https://the-letter-company.cal.com/mathew");
	});

	// Pointing FOUNDER_CALL_URL at a link that already carries parameters — a
	// specific duration, say — must not silently drop them.
	it("keeps parameters the configured link already had", () => {
		const u = new URL(taggedBookingUrl("https://cal.com/x/y?duration=20&month=2026-09"));
		expect(u.searchParams.get("duration")).toBe("20");
		expect(u.searchParams.get("month")).toBe("2026-09");
		expect(u.searchParams.get("metadata[source]")).toBe("lettertrace-dashboard");
	});

	it("does not stack duplicates if the tag is already present", () => {
		const once = taggedBookingUrl("https://cal.com/x/y");
		expect(taggedBookingUrl(once)).toBe(once);
	});

	/**
	 * A booking link that works is worth more than attribution, so a value that
	 * is not a URL is handed back untouched rather than mangled or dropped —
	 * misconfiguration should degrade to "no tracking", never to "no booking".
	 */
	it("returns an unparseable value untouched rather than breaking the link", () => {
		expect(taggedBookingUrl("not a url")).toBe("not a url");
	});
});
