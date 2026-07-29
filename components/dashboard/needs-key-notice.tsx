import Link from "next/link";
import { KeyRound } from "lucide-react";
import { Button, Card, CardBody } from "@/components/ui";
import { article, cn } from "@/lib/utils";

// "You need a key before this will work", in one place.
//
// This used to be written per-site, and drifted into three strengths: a proper
// callout on the Topics page, one line of grey helper text next to the button
// it actually blocks, and — on Competitors — nothing at all until the request
// came back with an error. The weak one sat inside a topic card, so by the time
// a user scrolled to the disabled Generate button the real notice was far
// offscreen, and the only thing left was unclickable grey text.
//
// Both variants therefore carry the same three things: the alert colour, the
// provider that's actually missing, and a link to fix it.
export function NeedsKeyNotice({
  providerLabel,
  /** Completes "Add a <provider> key to …" — name the blocked action. */
  action,
  /** Sits beside the control it blocks, rather than at the top of a page. */
  compact = false,
  className,
}: {
  providerLabel: string;
  action: string;
  compact?: boolean;
  className?: string;
}) {
  const message = `Add ${article(providerLabel)} ${providerLabel} key to ${action}.`;

  if (compact) {
    return (
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-terracotta/30 bg-terracotta/[0.07] px-3 py-2",
          className,
        )}
      >
        <span className="shrink-0 text-terracotta-dark">
          <KeyRound className="h-3.5 w-3.5" />
        </span>
        <p className="text-xs text-ink-soft">{message}</p>
        <Link
          href="/dashboard/settings"
          className="text-xs font-semibold text-terracotta-dark underline underline-offset-2 transition-colors hover:text-terracotta"
        >
          Add key
        </Link>
      </div>
    );
  }

  return (
    <Card className={cn("border-terracotta/30 bg-terracotta/[0.05]", className)}>
      <CardBody className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-terracotta-dark">
            <KeyRound className="h-5 w-5" />
          </span>
          <p className="text-sm text-ink-soft">{message}</p>
        </div>
        <Button href="/dashboard/settings" variant="secondary" size="sm">
          Add key
        </Button>
      </CardBody>
    </Card>
  );
}
