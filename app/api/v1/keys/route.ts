import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import { listProviderKeys, supportedProviders } from "@/lib/provider-keys";
import { logApiRequest } from "@/lib/activity";
import { humanError } from "@/lib/llm";

export const dynamic = "force-dynamic";

// GET /api/v1/keys — which BYOK provider keys the account has stored, masked.
//
// The response also carries the provider catalog. That is what keeps clients
// from hardcoding a provider list: the CLI renders whatever this returns, so a
// provider added to lib/models.ts appears in `lettertrace keys` with no client
// release. Auth: Bearer token with the "keys:read" scope.
export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "keys:read", "v1");
  if (auth instanceof Response) return auth;

  try {
    const keys = await listProviderKeys(auth.supabase, auth.userId);
    await logApiRequest(auth, request, "v1", {
      category: "provider_key",
      action: "api.list_provider_keys",
      summary: `Listed ${keys.length} provider key${keys.length === 1 ? "" : "s"} via the API`,
      statusCode: 200,
      metadata: { count: keys.length },
    });
    return NextResponse.json({ keys, providers: supportedProviders() });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
