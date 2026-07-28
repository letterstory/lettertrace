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

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded font-medium tracking-tight transition-all disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper";

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
}

export function Button({
  variant = "primary",
  size = "md",
  href,
  className,
  children,
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
    <button className={classes} {...props}>
      {children}
    </button>
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

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-4 w-4 animate-spin rounded-sm border-2 border-current border-t-transparent",
        className,
      )}
      aria-hidden
    />
  );
}
