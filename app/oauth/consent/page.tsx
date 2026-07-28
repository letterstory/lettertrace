import { redirect } from "next/navigation";
import { AlertCircle, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { claimPendingForUser, getClient, SCOPE_DESCRIPTIONS } from "@/lib/oauth";
import { Button, Card, CardBody } from "@/components/ui";
import { Logo } from "@/components/logo";

export const dynamic = "force-dynamic";

function safeHost(uri: string): { loopback: boolean; host: string } {
  try {
    const u = new URL(uri);
    const h = u.hostname.toLowerCase();
    const loopback = h === "127.0.0.1" || h === "::1" || h === "[::1]" || h === "localhost";
    return { loopback, host: u.host };
  } catch {
    return { loopback: false, host: uri };
  }
}

function ConsentShell({ children }: { children: React.ReactNode }) {
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

function ConsentError({ message }: { message: string }) {
  return (
    <ConsentShell>
      <div className="space-y-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded bg-terracotta/12 text-terracotta-dark">
          <AlertCircle className="h-6 w-6" aria-hidden />
        </div>
        <h1 className="font-serif text-xl font-semibold text-ink">
          Can&apos;t complete this request
        </h1>
        <p className="text-sm text-ink-faint">{message}</p>
        <Button href="/dashboard" variant="secondary" className="w-full">
          Back to dashboard
        </Button>
      </div>
    </ConsentShell>
  );
}

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: { req?: string };
}) {
  const reqId = typeof searchParams.req === "string" ? searchParams.req : "";
  const consentPath = `/oauth/consent?req=${encodeURIComponent(reqId)}`;

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(consentPath)}`);

  const service = createServiceClient();
  const claimed = await claimPendingForUser(service, reqId, user.id);
  if (!claimed) {
    return (
      <ConsentError message="This authorization request has expired or is invalid. Start again from your CLI or app." />
    );
  }
  const { pending, nonce } = claimed;
  const client = await getClient(service, pending.client_id);
  if (!client) {
    return (
      <ConsentError message="The application making this request is no longer registered." />
    );
  }

  const dest = safeHost(pending.redirect_uri);
  const surface = pending.resource === "mcp" ? "MCP tools" : "REST API";

  return (
    <ConsentShell>
      <div className="space-y-6">
        <div className="text-center">
          <h1 className="font-serif text-2xl font-semibold text-ink">Authorize access</h1>
          <p className="mt-1 text-sm text-ink-faint">
            Signed in as <span className="font-medium text-ink-soft">{user.email}</span>
          </p>
        </div>

        <div className="rounded border border-ink/10 bg-surface px-4 py-3.5">
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink">{client.client_name}</span>
            {client.is_first_party ? (
              <span className="inline-flex items-center gap-1 rounded-sm bg-mint-tint px-2 py-0.5 text-xs font-medium text-mint-ink">
                <ShieldCheck className="h-3 w-3" aria-hidden /> First-party
              </span>
            ) : (
              <span className="rounded-sm bg-butter/50 px-2 py-0.5 text-xs font-medium text-ink-soft">
                Unverified
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-ink-faint">
            wants to access your Lettertrace account&apos;s {surface}.
          </p>
        </div>

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
            It will be able to
          </p>
          <ul className="mt-2 space-y-2">
            {pending.scopes.map((scope) => (
              <li key={scope} className="flex items-start gap-2 text-sm text-ink-soft">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-mint-ink" aria-hidden />
                <span>{SCOPE_DESCRIPTIONS[scope] ?? scope}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="rounded border border-ink/10 bg-paper-shade px-4 py-3 text-xs text-ink-faint">
          A code will be delivered to{" "}
          <span className="font-medium text-ink-soft">
            {dest.loopback ? "an application on this device" : dest.host}
          </span>
          . Only approve if you started this yourself.
        </p>

        <form method="post" action="/api/oauth/authorize/consent" className="space-y-3">
          <input type="hidden" name="req" value={pending.id} />
          <input type="hidden" name="nonce" value={nonce} />
          <Button type="submit" name="decision" value="approve" size="lg" className="w-full">
            Approve
          </Button>
          <Button
            type="submit"
            name="decision"
            value="deny"
            variant="secondary"
            size="lg"
            className="w-full"
          >
            Deny
          </Button>
        </form>
      </div>
    </ConsentShell>
  );
}
