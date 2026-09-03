import { redirect } from "next/navigation";
import { AlertCircle, MailX, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { previewInvite } from "@/lib/team";
import { Button, Card, CardBody } from "@/components/ui";
import { Logo } from "@/components/logo";
import { formatDate } from "@/lib/utils";
import { AcceptInvite } from "./accept-invite";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

/**
 * Where an invitation link lands.
 *
 * Reading the link never spends it — accepting is a POST behind the button
 * below, because mail scanners and link previewers fetch every URL in an
 * incoming message and would otherwise accept invitations on their
 * recipients' behalf. See previewInvite in lib/team.
 *
 * A signed-out visitor never reaches this component: middleware bounces them
 * to /login?next=/invite/<token>, so the sign-up they may need to do comes
 * first and returns them here. That is also why the token is a path segment
 * rather than a query param — the login redirect strips the query string.
 */

function InviteShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-6 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <Card>
          <CardBody className="p-8 sm:p-10">{children}</CardBody>
        </Card>
      </div>
    </main>
  );
}

function InviteProblem({
  title,
  message,
  icon,
}: {
  title: string;
  message: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <InviteShell>
      <div className="space-y-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded bg-terracotta/12 text-terracotta-dark">
          {icon ?? <AlertCircle className="h-6 w-6" aria-hidden />}
        </div>
        <h1 className="font-serif text-xl font-semibold text-ink">{title}</h1>
        <p className="text-sm text-ink-faint">{message}</p>
        <Button href="/dashboard" variant="secondary" className="w-full">
          Go to your dashboard
        </Button>
      </div>
    </InviteShell>
  );
}

export default async function InvitePage({ params }: { params: { token: string } }) {
  const token = decodeURIComponent(params.token);
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Middleware already did this; the redirect stays as the belt to its braces,
  // because the alternative to a missing session here is a crash on user.id.
  if (!user) redirect(`/login?next=${encodeURIComponent(`/invite/${params.token}`)}`);

  const preview = await previewInvite(createServiceClient(), token, {
    userId: user.id,
    email: user.email ?? null,
  });
  const organization = preview.organization ?? "an organization";

  switch (preview.state) {
    case "unknown":
      return (
        <InviteProblem
          title="This invitation link isn't valid"
          message="Check that you copied the whole link from the email. If it was withdrawn, ask whoever invited you to send a new one."
        />
      );
    case "expired":
      return (
        <InviteProblem
          title="This invitation has expired"
          message={`Invitations last a week. Ask ${preview.invitedByEmail ?? "whoever invited you"} to send a new one — it takes them one click.`}
        />
      );
    case "revoked":
      return (
        <InviteProblem
          title="This invitation was withdrawn"
          message={`${preview.invitedByEmail ?? "The person who invited you"} cancelled it. If that's unexpected, it's worth asking them directly.`}
        />
      );
    case "accepted":
      return (
        <InviteProblem
          title="This invitation has already been used"
          message="Somebody has already joined with this link, and each one works once. Ask for a fresh invitation."
        />
      );
    case "wrong-email":
      return (
        <InviteProblem
          icon={<MailX className="h-6 w-6" aria-hidden />}
          title="This invitation is for a different address"
          message={
            <>
              It was sent to{" "}
              <span className="font-medium text-ink-soft">{preview.email}</span>, and you&apos;re
              signed in as <span className="font-medium text-ink-soft">{user.email}</span>. Sign
              in as the invited address and open the link again — an invitation admits the person
              it names, not whoever holds the link.
            </>
          }
        />
      );
    case "ready":
      break;
    default:
      return (
        <InviteProblem
          title="This invitation link isn't valid"
          message="Ask whoever invited you to send a new one."
        />
      );
  }

  return (
    <InviteShell>
      <div className="space-y-6">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded bg-mint-tint text-mint-ink">
            <Users className="h-6 w-6" aria-hidden />
          </div>
          <h1 className="font-serif text-2xl font-semibold text-ink">
            {preview.alreadyMember ? "You're already on this team" : "Join this team"}
          </h1>
          <p className="mt-1 text-sm text-ink-faint">
            Signed in as <span className="font-medium text-ink-soft">{user.email}</span>
          </p>
        </div>

        <div className="rounded border border-ink/10 bg-surface px-4 py-3.5">
          <p className="font-medium text-ink">{organization}</p>
          <p className="mt-1 text-sm text-ink-faint">
            {preview.invitedByEmail
              ? `${preview.invitedByEmail} invited you to this organization on Lettertrace.`
              : "You were invited to this organization on Lettertrace."}
          </p>
        </div>

        {!preview.alreadyMember && (
          <>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                As a member you can
              </p>
              <ul className="mt-2 space-y-1.5 text-sm text-ink-soft">
                <li>See this organization&apos;s prompts, competitors, and results</li>
                <li>Start runs, paid for by the owner&apos;s account</li>
                <li>Edit what gets monitored</li>
              </ul>
              <p className="mt-3 text-xs text-ink-faint">
                You will not see the owner&apos;s API keys, and you can leave at any time from
                Settings.
              </p>
            </div>
            {preview.expiresAt && (
              <p className="text-xs text-ink-faint">
                This invitation expires {formatDate(preview.expiresAt)}.
              </p>
            )}
          </>
        )}

        <AcceptInvite token={token} alreadyMember={preview.alreadyMember} />
      </div>
    </InviteShell>
  );
}
