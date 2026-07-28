import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-guards";
import { setPromptActive } from "@/lib/api-service";
import { humanError } from "@/lib/llm";

export const dynamic = "force-dynamic";

// PATCH /api/v1/prompts/:id — toggle a prompt. Body: { is_active: boolean }
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  const auth = await requireApiAuth(request, "projects:write", "v1");
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { is_active } = (body ?? {}) as { is_active?: unknown };
  if (typeof is_active !== "boolean") {
    return NextResponse.json(
      { error: "is_active must be a boolean." },
      { status: 400 },
    );
  }

  try {
    const prompt = await setPromptActive(
      auth.supabase,
      auth.userId,
      params.id,
      is_active,
    );
    if (!prompt) {
      return NextResponse.json({ error: "Prompt not found" }, { status: 404 });
    }
    return NextResponse.json({ prompt });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
