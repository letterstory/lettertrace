import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { generateApiKey, hashApiKey, keyHint } from "@/lib/crypto";
import { humanError } from "@/lib/llm";

// Session-authenticated management of Lettertrace API keys (settings page).
// The plaintext key is returned exactly once, from POST.

const MAX_KEYS_PER_USER = 10;

export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data } = await supabase
    .from("api_keys")
    .select("id, name, key_hint, last_used_at, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });
  return NextResponse.json({ keys: data ?? [] });
}

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
  const { name } = (body ?? {}) as { name?: unknown };
  const cleanName =
    typeof name === "string" && name.trim().length > 0
      ? name.trim().slice(0, 80)
      : "API key";

  try {
    const { count } = await supabase
      .from("api_keys")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);
    if ((count ?? 0) >= MAX_KEYS_PER_USER) {
      return NextResponse.json(
        { error: `You can have at most ${MAX_KEYS_PER_USER} API keys. Remove one first.` },
        { status: 400 },
      );
    }

    const plaintext = generateApiKey();
    const { data, error } = await supabase
      .from("api_keys")
      .insert({
        user_id: user.id,
        name: cleanName,
        key_hash: hashApiKey(plaintext),
        key_hint: keyHint(plaintext),
      })
      .select("id, name, key_hint, last_used_at, created_at")
      .single();
    if (error) {
      return NextResponse.json({ error: humanError(error) }, { status: 500 });
    }

    // The one and only time the plaintext leaves the server.
    return NextResponse.json({ key: data, apiKey: plaintext });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
