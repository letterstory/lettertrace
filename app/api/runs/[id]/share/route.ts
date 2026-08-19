import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createShareLink } from "@/lib/share-links";
import { logDashboard } from "@/lib/activity";
import { humanError } from "@/lib/llm";

export const dynamic = "force-dynamic";

// POST /api/runs/:id/share — mint (or rotate) the anonymous, no-login share
// link for one run the caller owns. See lib/share-links.ts: sharing a run
// that already has a link rotates it, invalidating the previous one.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const outcome = await createShareLink(supabase, user.id, params.id);
    if (!outcome.ok) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }

    await logDashboard(user, request, {
      category: "share_link",
      action: "share_link.created",
      summary: "Created a public share link for a run",
      targetType: "run",
      targetId: params.id,
    });

    // The plaintext token, embedded in the share URL, leaves the server here
    // and only here — the stored row keeps only its hash.
    return NextResponse.json({ token: outcome.token, expiresAt: outcome.expiresAt });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
