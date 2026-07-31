import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import { listRouterKeys, supportedRouters } from "@/lib/router-keys";
import { logApiRequest } from "@/lib/activity";
import { humanError } from "@/lib/llm";

export const dynamic = "force-dynamic";

// GET /api/v1/router-keys — which LLM router credentials the account holds,
// masked, plus the router catalog.
//
// Same shape and same reasoning as /api/v1/keys: the catalog travels with the
// response so the CLI renders whatever the deployment supports instead of
// shipping its own copy of the list. Each catalog entry names the engines that
// router can serve, because "which models does it have" and "which of them can
// Lettertrace measure through it" are different questions.
//
// Auth: Bearer token with the "keys:read" scope — a router key is the same class
// of credential as a provider key, so it is deliberately not a new scope that
// every existing token would lack.
export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "keys:read", "v1");
  if (auth instanceof Response) return auth;

  try {
    const keys = await listRouterKeys(auth.supabase, auth.userId);
    await logApiRequest(auth, request, "v1", {
      category: "router_key",
      action: "api.list_router_keys",
      summary: `Listed ${keys.length} router key${keys.length === 1 ? "" : "s"} via the API`,
      statusCode: 200,
      metadata: { count: keys.length },
    });
    return NextResponse.json({ keys, routers: supportedRouters() });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
