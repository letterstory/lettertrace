import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { normalizeProductUrl } from "@/lib/conversions";

export const dynamic = "force-dynamic";

// POST /api/out — record a click on an outbound Letter Company product link.
// Fired by components/outbound-link.tsx via sendBeacon as the browser leaves,
// which shapes everything here: the sender never reads the response, so every
// outcome (bad body, unknown host, insert failure) ends in an empty 2xx — the
// only hard refusal is no session, because a row needs a user to belong to.
//
// The URL is normalized AND allow-listed by normalizeProductUrl before it is
// stored: an authenticated caller poking this endpoint directly can at worst
// record that they "clicked" a real Letter product URL — never fill the table
// with arbitrary strings.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let raw: unknown;
  try {
    raw = (await request.json()) as unknown;
  } catch {
    raw = null;
  }
  const candidate =
    raw && typeof raw === "object" && "url" in raw ? (raw as { url: unknown }).url : null;
  const url = typeof candidate === "string" ? normalizeProductUrl(candidate) : null;
  if (!url) return new NextResponse(null, { status: 204 });

  try {
    await createServiceClient()
      .from("outbound_clicks")
      .insert({ user_id: user.id, url });
  } catch {
    // Telemetry never breaks (or delays) the navigation it is recording.
  }
  return new NextResponse(null, { status: 204 });
}
