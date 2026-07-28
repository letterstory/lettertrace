import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setProviderKey } from "@/lib/provider-keys";
import { logDashboard } from "@/lib/activity";

// Dashboard (cookie-session) path for saving a BYOK provider key. The verify →
// encrypt → store sequence lives in lib/provider-keys so this route and the
// CLI-facing /api/v1/keys route cannot drift apart on the part that matters.
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

  const { provider, apiKey, label } = (body ?? {}) as {
    provider?: unknown;
    apiKey?: unknown;
    label?: unknown;
  };

  const outcome = await setProviderKey(supabase, user.id, { provider, apiKey, label });
  if (!outcome.ok) {
    // `misconfigured` is the deployment's fault, not the user's, so it must not
    // land on the key field as validation feedback — 503, and the message says
    // the key itself was fine.
    const status =
      outcome.code === "misconfigured" ? 503 : outcome.code === "failed" ? 500 : 400;
    return NextResponse.json({ error: outcome.message }, { status });
  }

  await logDashboard(user, request, {
    category: "provider_key",
    action: "provider_key.saved",
    summary: `Saved a ${outcome.key.provider} provider key (${outcome.key.key_hint})`,
    targetType: "provider_key",
    targetId: outcome.key.id,
    metadata: { provider: outcome.key.provider, key_hint: outcome.key.key_hint },
  });

  return NextResponse.json(outcome.key);
}
