import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import {
  parseProvider,
  removeProviderKey,
  setProviderKey,
  unknownProviderMessage,
} from "@/lib/provider-keys";
import { logApiRequest } from "@/lib/activity";
import { humanError } from "@/lib/llm";

export const dynamic = "force-dynamic";

// The account holds at most one key per provider, so the provider IS the
// resource id here — no lookup round-trip before a write, and PUT is honestly
// idempotent: setting and rotating a key are the same request.

// PUT /api/v1/keys/:provider — verify, encrypt, and store a BYOK key.
// Body: { api_key: string, label?: string }
// Auth: Bearer token with the "keys:write" scope.
//
// The key travels in the JSON body and nowhere else: never a query parameter
// (proxy and server access logs record those verbatim) and never a path
// segment. It is also never echoed back — the response carries only the masked
// hint, which is all any client needs to confirm the right key landed.
export async function PUT(
  request: Request,
  { params }: { params: { provider: string } },
) {
  const auth = await requireApiAuth(request, "keys:write", "v1");
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { api_key, label } = (body ?? {}) as { api_key?: unknown; label?: unknown };

  const outcome = await setProviderKey(auth.supabase, auth.userId, {
    provider: params.provider,
    apiKey: api_key,
    label,
  });

  if (!outcome.ok) {
    // A misconfigured ENCRYPTION_KEY is the operator's problem, not the
    // caller's: 503 (retriable once someone fixes the deployment), never the
    // 400 that would tell a user their perfectly good key was rejected.
    const status =
      outcome.code === "misconfigured" ? 503 : outcome.code === "failed" ? 500 : 400;
    await logApiRequest(auth, request, "v1", {
      category: "provider_key",
      action: "api.set_provider_key",
      status: "failure",
      statusCode: status,
      summary: `Provider key not saved via the API: ${outcome.message}`,
      metadata: { provider: params.provider, reason: outcome.code },
    });
    return NextResponse.json({ error: outcome.message }, { status });
  }

  await logApiRequest(auth, request, "v1", {
    category: "provider_key",
    action: "provider_key.saved",
    statusCode: 200,
    targetType: "provider_key",
    targetId: outcome.key.id,
    summary: `Saved a ${outcome.key.provider} provider key (${outcome.key.key_hint})`,
    metadata: { provider: outcome.key.provider, key_hint: outcome.key.key_hint },
  });
  return NextResponse.json({ key: outcome.key });
}

// DELETE /api/v1/keys/:provider — forget the stored key for one provider.
// Auth: Bearer token with the "keys:write" scope.
export async function DELETE(
  request: Request,
  { params }: { params: { provider: string } },
) {
  const auth = await requireApiAuth(request, "keys:write", "v1");
  if (auth instanceof Response) return auth;

  const provider = parseProvider(params.provider);
  if (!provider) {
    return NextResponse.json({ error: unknownProviderMessage() }, { status: 400 });
  }

  try {
    const removed = await removeProviderKey(auth.supabase, auth.userId, provider);
    if (!removed) {
      // Nothing stored. Reported as 404 rather than a cheerful 200 so a script
      // that thinks it just revoked a key isn't quietly wrong.
      return NextResponse.json(
        { error: `No ${provider} key is stored for this account.` },
        { status: 404 },
      );
    }
    await logApiRequest(auth, request, "v1", {
      category: "provider_key",
      action: "provider_key.removed",
      statusCode: 200,
      targetType: "provider_key",
      targetId: removed.id,
      summary: `Removed the ${provider} provider key (${removed.key_hint}) via the API`,
      metadata: { provider, key_hint: removed.key_hint },
    });
    return NextResponse.json({ ok: true, key: removed });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
