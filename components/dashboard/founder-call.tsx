"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, CalendarCheck, X } from "lucide-react";
import { Button } from "@/components/ui";
import { FOUNDER_CALL_DELAY_MS } from "@/lib/founder-call";

/**
 * Offers a setup call with the founder, once, half a minute after a new user
 * lands in the dashboard.
 *
 * Whether this user is eligible is decided on the server (see the dashboard
 * layout) — this island only owns the timer and the dialog. It is mounted in
 * the layout rather than a page so the countdown survives navigating between
 * dashboard routes: someone clicking around for the first thirty seconds is
 * exactly who the offer is for, and a per-page timer would keep restarting and
 * never fire for them.
 *
 * The offer is marked as made when it is SHOWN, not when it is answered.
 * Recording it on dismissal would leave a user who closes the tab mid-dialog
 * eligible forever, and being asked the same question on every visit reads as
 * broken software rather than attentiveness. One ask is the product decision;
 * this is where it is enforced.
 */
export function FounderCallOffer({ url }: { url: string }) {
	const [open, setOpen] = useState(false);

	useEffect(() => {
		const timer = setTimeout(() => setOpen(true), FOUNDER_CALL_DELAY_MS);
		return () => clearTimeout(timer);
	}, []);

	if (!open) return null;
	return <FounderCallDialog url={url} onClose={() => setOpen(false)} />;
}

function FounderCallDialog({ url, onClose }: { url: string; onClose: () => void }) {
	const [mounted, setMounted] = useState(false);
	const marked = useRef(false);

	useEffect(() => setMounted(true), []);

	// Record the ask as soon as it is on screen. keepalive so it still lands if
	// the user books immediately and the tab navigates away mid-flight.
	useEffect(() => {
		if (marked.current) return;
		marked.current = true;
		// A failure here costs one repeated prompt on a later visit, which is a
		// far better outcome than blocking the dialog on a write.
		void fetch("/api/founder-call", { method: "POST", keepalive: true }).catch(() => {});
	}, []);

	// Escape to close; lock body scroll while the dialog is up. Same handling as
	// the "Why is this free?" dialog.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.removeEventListener("keydown", onKey);
			document.body.style.overflow = prev;
		};
	}, [onClose]);

	const book = useCallback(() => {
		// noopener/noreferrer on an untrusted-by-default external target, and a
		// new tab so a half-finished onboarding form is not thrown away.
		window.open(url, "_blank", "noopener,noreferrer");
		onClose();
	}, [url, onClose]);

	if (!mounted) return null;

	return createPortal(
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center p-4"
			role="dialog"
			aria-modal="true"
			aria-labelledby="founder-call-title"
		>
			<div className="absolute inset-0 bg-ink/40 backdrop-blur-sm animate-fade-up" onClick={onClose} />

			{/* Composed from the marketing page's own vocabulary — mono eyebrow,
			    serif heading, terracotta glyph in a rounded square, arrow on the
			    primary action — so the first thing a new user is asked inside the
			    product looks like the site that sold it to them. */}
			<div className="relative w-full max-w-md overflow-hidden rounded border border-ink/10 bg-paper shadow-lift animate-fade-up">
				<button
					type="button"
					onClick={onClose}
					aria-label="Close"
					className="absolute right-3 top-3 rounded p-1.5 text-ink-faint transition hover:bg-ink/[0.05] hover:text-ink"
				>
					<X className="h-4 w-4" />
				</button>

				<div className="p-6">
					{/* Glyph leads the eyebrow rather than sitting opposite it: the top
					    right corner belongs to the close button, and the two collided
					    there. `pr-8` keeps the row clear of it at narrow widths. */}
					<div className="flex items-center gap-3 pr-8">
						<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-ink/[0.04] text-terracotta-dark">
							<CalendarCheck className="h-5 w-5" />
						</span>
						<p className="mono-eyebrow">getting started</p>
					</div>

					<h2
						id="founder-call-title"
						className="mt-4 text-2xl font-semibold tracking-tight text-ink"
					>
						Want a hand getting set up?
					</h2>

					<p className="mt-3 text-sm leading-relaxed text-ink-faint">
						Book time with Mathew, our founder. He&apos;ll walk you through your brand and
						topics, and what to watch for once results start coming in.
					</p>

					{/* Stacked rather than side by side, so the two options are not read
					    as equal weight. Booking is the reason the dialog exists; declining
					    stays one click away but does not compete for the same line. */}
					<div className="mt-7 flex flex-col gap-1">
						<Button size="lg" onClick={book} className="w-full">
							Pick a time
							<ArrowRight className="h-4 w-4" />
						</Button>
						<Button variant="ghost" size="sm" onClick={onClose} className="w-full">
							Not right now
						</Button>
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}
