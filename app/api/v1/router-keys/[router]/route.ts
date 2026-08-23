import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import {
  removeRouterKey,
  setRouterKey,
  verificationSummary,
} from "@/lib/router-keys";
import { parseRouterId, unknownRouterMessage } from "@/lib/routers";
import { logApiRequest } from "@/lib/activity";
import { humanError } from "@/lib/llm";

export const dynamic = "force-dynamic";

// The account holds at most one credential per router, so the router IS the
// resource id — PUT is honestly idempotent, and setting and rotating are the
// same request. Mirrors /api/v1/keys/:provider deliberately.

// PUT /api/v1/router-keys/:router — verify, check what it can measure, encrypt,
// and store an LLM router credential.
// Body: { api_key: string, label?: string, base_url?: string }
// Auth: Bearer token with the "keys:write" scope.
//
// The key travels in the JSON body and nowhere else — never a query parameter
// (access logs record those verbatim), never a path segment — and is never
// echoed back. `checks` in the response is the part worth reading: it says, per
// engine, whether this credential can carry a grounded measurement.
export async function PUT(
  request: Request,
  { params }: { params: { router: string } },
) {
  const auth = await requireApiAuth(request, "keys:write", "v1");
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { api_key, label, base_url } = (body ?? {}) as {
    api_key?: unknown;
    label?: unknown;
    base_url?: unknown;
  };

  const outcome = await setRouterKey(auth.supabase, auth.userId, {
    router: params.router,
    apiKey: api_key,
    label,
    baseUrl: base_url,
  });

  if (!outcome.ok) {
    const status =
      outcome.code === "misconfigured" ? 503 : outcome.code === "failed" ? 500 : 400;
    await logApiRequest(auth, request, "v1", {
      category: "router_key",
      action: "api.set_router_key",
      status: "failure",
      statusCode: status,
      summary: `Router key not saved via the API: ${outcome.message}`,
      metadata: { router: params.router, reason: outcome.code },
    });
    return NextResponse.json({ error: outcome.message }, { status });
  }

  await logApiRequest(auth, request, "v1", {
    category: "router_key",
    action: "router_key.saved",
    statusCode: 200,
    targetType: "router_key",
    targetId: outcome.key.id,
    summary: `Saved a ${outcome.key.router} router key (${outcome.key.key_hint}): ${verificationSummary(outcome.verification)}`,
    metadata: {
      router: outcome.key.router,
      key_hint: outcome.key.key_hint,
      reachable: outcome.verification.reachable,
      search_verified: outcome.verification.searchVerified,
    },
  });
  return NextResponse.json({ key: outcome.key, checks: outcome.verification.checks });
}

// DELETE /api/v1/router-keys/:router — forget the stored credential.
// Auth: Bearer token with the "keys:write" scope.
export async function DELETE(
  request: Request,
  { params }: { params: { router: string } },
) {
  const auth = await requireApiAuth(request, "keys:write", "v1");
  if (auth instanceof Response) return auth;

  const router = parseRouterId(params.router);
  if (!router) {
    return NextResponse.json({ error: unknownRouterMessage() }, { status: 400 });
  }

  try {
    const removed = await removeRouterKey(auth.supabase, auth.userId, router);
    if (!removed) {
      // 404 rather than a cheerful 200, so a script that believes it just
      // revoked a credential isn't quietly wrong.
      return NextResponse.json(
        { error: `No ${router} router key is stored for this account.` },
        { status: 404 },
      );
    }
    await logApiRequest(auth, request, "v1", {
      category: "router_key",
      action: "router_key.removed",
      statusCode: 200,
      targetType: "router_key",
      targetId: removed.id,
      summary: `Removed the ${router} router key (${removed.key_hint}) via the API`,
      metadata: { router, key_hint: removed.key_hint },
    });
    return NextResponse.json({ ok: true, key: removed });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
