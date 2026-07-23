import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isProvider } from "@/lib/models";
import { verifyKey, humanError } from "@/lib/llm";
import { encryptSecret, keyHint } from "@/lib/crypto";

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

  if (typeof provider !== "string" || !isProvider(provider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    return NextResponse.json({ error: "An API key is required" }, { status: 400 });
  }

  const key = apiKey.trim();
  const cleanLabel =
    typeof label === "string" && label.trim().length > 0 ? label.trim() : null;

  try {
    const v = await verifyKey(provider, key);
    if (!v.ok) {
      return NextResponse.json(
        { error: v.error || "Key verification failed" },
        { status: 400 },
      );
    }

    const encrypted_key = encryptSecret(key);
    const key_hint = keyHint(key);

    const { data, error } = await supabase
      .from("provider_keys")
      .upsert(
        {
          user_id: user.id,
          provider,
          label: cleanLabel,
          encrypted_key,
          key_hint,
        },
        { onConflict: "user_id,provider" },
      )
      .select("id, provider, label, key_hint, created_at")
      .single();

    if (error) {
      return NextResponse.json({ error: humanError(error) }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
