import Link from "next/link";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------
// Presentational primitives (no hooks -> usable in Server or Client
// components). Interactive pieces live in their own "use client" files.
// Light-mode / phantom aesthetic: ink buttons, hairline borders, pastels.
// ------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

// `transition-colors`, not `transition-all`. A button's label changes width when
// it swaps to a loading state ("Save changes" -> "Saving..."), and `all` animates
// the resulting width and height too: the button crawls to its new size, and
// mid-transition it reads as two overlapping buttons with two overlapping labels.
// Nothing here needs a layout property animated — only the hover/focus colours do.
const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded font-medium tracking-tight transition-colors disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-ink text-paper hover:bg-ink/90 shadow-sm",
  secondary: "bg-surface text-ink border border-ink/15 hover:border-ink/35 hover:bg-ink/[0.02]",
  ghost: "bg-transparent text-ink-soft hover:bg-ink/[0.05] hover:text-ink",
  danger: "bg-transparent text-terracotta-dark border border-terracotta/30 hover:bg-terracotta/10",
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-9 px-4 text-sm",
  md: "h-11 px-5 text-[0.95rem]",
  lg: "h-12 px-7 text-base",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  href?: string;
  /** In flight: shows a spinner and blocks input. */
  loading?: boolean;
  /** What to say while loading. Defaults to the idle label. */
  loadingText?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  href,
  className,
  children,
  loading,
  loadingText,
  disabled,
  ...props
}: ButtonProps) {
  const classes = cn(buttonBase, buttonVariants[variant], buttonSizes[size], className);
  if (href) {
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }
  return (
    <button
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading === undefined ? children : <ButtonLabel loading={loading} loadingText={loadingText}>{children}</ButtonLabel>}
    </button>
  );
}

/**
 * Both labels, stacked in one grid cell, with the inactive one hidden by
 * `visibility` rather than unmounted.
 *
 * The button is therefore always as wide as its widest state, so entering and
 * leaving the loading state moves nothing — no reflow of the row it sits in, no
 * width for a transition to animate, and no window in which two labels can be
 * painted at once. Rendering only the active label would be simpler and is what
 * the call sites used to do by hand; it is also what made the button resize
 * under the user's cursor every time they saved.
 */
function ButtonLabel({
  loading,
  loadingText,
  children,
}: {
  loading: boolean;
  loadingText?: ReactNode;
  children: ReactNode;
}) {
  return (
    <span className="grid place-items-center">
      <span
        className={cn(
          "col-start-1 row-start-1 inline-flex items-center gap-2",
          loading && "invisible",
        )}
      >
        {children}
      </span>
      <span
        className={cn(
          "col-start-1 row-start-1 inline-flex items-center gap-2",
          !loading && "invisible",
        )}
        // Hidden from assistive tech when idle; when loading, aria-busy on the
        // button plus this text is what announces the state.
        aria-hidden={!loading}
      >
        <Spinner />
        {loadingText ?? children}
      </span>
    </span>
  );
}

export function Card({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("rounded border border-ink/10 bg-surface shadow-card", className)}>
      {children}
    </div>
  );
}

export function CardBody({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("p-6", className)}>{children}</div>;
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 className="text-2xl font-semibold text-ink">{title}</h2>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-faint">{description}</p>}
      </div>
      {action}
    </div>
  );
}

type BadgeTone = "neutral" | "terracotta" | "mint" | "teal" | "butter" | "sand";

const badgeTones: Record<BadgeTone, string> = {
  neutral: "bg-ink/[0.06] text-ink-soft",
  terracotta: "bg-terracotta/15 text-terracotta-dark",
  mint: "bg-mint-tint text-mint-ink",
  teal: "bg-teal/15 text-teal-dark",
  butter: "bg-butter-tint text-butter-ink",
  sand: "bg-sand-tint text-ink-soft",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm px-2.5 py-0.5 text-xs font-medium",
        badgeTones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Label({
  className,
  children,
  htmlFor,
}: {
  className?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <label htmlFor={htmlFor} className={cn("mb-1.5 block text-sm font-medium text-ink-soft", className)}>
      {children}
    </label>
  );
}

const fieldBase =
  "w-full rounded border border-ink/15 bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-faint/70 transition focus:border-terracotta focus:outline-none focus:ring-2 focus:ring-terracotta/20";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldBase, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldBase, "min-h-[90px] resize-y", className)} {...props} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(fieldBase, "appearance-none pr-9", className)} {...props}>
      {children}
    </select>
  );
}

const accentDot: Record<BadgeTone, string> = {
  neutral: "bg-ink/30",
  terracotta: "bg-terracotta",
  mint: "bg-mint-bright",
  teal: "bg-teal",
  butter: "bg-butter",
  sand: "bg-sand",
};

export function StatCard({
  label,
  value,
  hint,
  accent = "terracotta",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: BadgeTone;
}) {
  return (
    <Card>
      <CardBody className="p-5">
        <div className="flex items-center gap-2">
          <span className={cn("h-2 w-2 rounded-sm", accentDot[accent])} />
          <p className="text-sm font-medium text-ink-faint">{label}</p>
        </div>
        <p className="mt-2 font-serif text-3xl font-semibold text-ink">{value}</p>
        {hint && <p className="mt-1 text-xs text-ink-faint">{hint}</p>}
      </CardBody>
    </Card>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded border border-dashed border-ink/15 bg-paper-shade/40 px-6 py-14 text-center">
      {icon && <div className="mb-3 text-terracotta">{icon}</div>}
      <h3 className="text-lg font-semibold text-ink">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-ink-faint">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/**
 * Indeterminate loading indicator: a circular track with a rotating arc.
 *
 * Was a `rounded-sm` bordered box with a transparent top edge, which is the
 * cheap CSS trick for a spinner and looks like exactly what it is — a square
 * corner tumbling end over end. Two things fix that. An actual circle, so the
 * silhouette doesn't change as it turns, and a low-opacity full ring behind the
 * arc, which gives the arc a path to travel along: without it the eye reads a
 * shape flickering, with it the eye reads rotation.
 *
 * `shrink-0` because this is nearly always a flex child next to a label, and a
 * shrinkable circle becomes an oval on a narrow button.
 *
 * Sized and coloured through `className` (height/width and text colour), since
 * it draws with currentColor and inherits from whatever it sits inside.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      // Slower rather than stopped under reduced motion: a frozen spinner is
      // indistinguishable from a hung request, which is worse than the motion.
      className={cn(
        "h-4 w-4 shrink-0 animate-spin [animation-duration:0.7s] motion-reduce:[animation-duration:2.4s]",
        className,
      )}
      aria-hidden
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
