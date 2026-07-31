import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setRouterKey, toPublic, verificationSummary } from "@/lib/router-keys";
import { logDashboard } from "@/lib/activity";

// Dashboard (cookie-session) path for saving an LLM router credential. The
// verify → probe → encrypt → store sequence lives in lib/router-keys, alongside
// the provider-key equivalent, so the two can't drift on the security-critical
// ordering.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { router, apiKey, label, baseUrl } = (body ?? {}) as {
    router?: unknown;
    apiKey?: unknown;
    label?: unknown;
    baseUrl?: unknown;
  };

  const outcome = await setRouterKey(supabase, user.id, { router, apiKey, label, baseUrl });
  if (!outcome.ok) {
    const status =
      outcome.code === "misconfigured" ? 503 : outcome.code === "failed" ? 500 : 400;
    return NextResponse.json({ error: outcome.message }, { status });
  }

  await logDashboard(user, request, {
    category: "router_key",
    action: "router_key.saved",
    summary: `Saved a ${outcome.key.router} router key (${outcome.key.key_hint}) — ${verificationSummary(outcome.verification)}`,
    targetType: "router_key",
    targetId: outcome.key.id,
    metadata: {
      router: outcome.key.router,
      key_hint: outcome.key.key_hint,
      reachable: outcome.verification.reachable,
      search_verified: outcome.verification.searchVerified,
    },
  });

  // The checks travel with the response so the settings card can say what this
  // credential can and can't measure, rather than only "saved".
  return NextResponse.json({
    ...toPublic(outcome.key),
    checks: outcome.verification.checks,
  });
}
