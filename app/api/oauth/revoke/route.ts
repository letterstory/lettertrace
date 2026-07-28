import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { clientIp, rateLimit } from "@/lib/oauth-ratelimit";
import { revokeByToken } from "@/lib/oauth";

export const dynamic = "force-dynamic";

// POST /api/oauth/revoke — RFC 7009 token revocation.
// Possession of the token is the authorization; we reveal nothing about whether
// it existed, and always return 200. Revoking any token kills its whole family.
export async function POST(request: Request) {
  const rl = await rateLimit(`revoke:${clientIp(request)}`, 60, 120);
  if (!rl.allowed) return new NextResponse(null, { status: 200 });

  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await request.text());
  } catch {
    return new NextResponse(null, { status: 200 });
  }

  const token = form.get("token");
  if (token) {
    try {
      await revokeByToken(createServiceClient(), token);
    } catch (e) {
      // Never surface anything: RFC 7009 wants an unconditional 200.
      console.error("[oauth/revoke] error:", e instanceof Error ? e.message : e);
    }
  }
  return new NextResponse(null, { status: 200 });
}
