import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";

export async function PATCH(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const project = await getProject(supabase, user.id);
  if (!project) return NextResponse.json({ error: "Create an organization first." }, { status: 400 });
  if (project.user_id !== user.id) {
    return NextResponse.json({ error: "Only the organization owner can change report emails." }, { status: 403 });
  }
  const body = await request.json().catch(() => null) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "Choose on or off for report emails." }, { status: 400 });
  }
  const { data, error } = await supabase.from("projects")
    .update({ report_emails_enabled: body.enabled })
    .eq("id", project.id).eq("user_id", user.id)
    .select("report_emails_enabled").single();
  if (error) return NextResponse.json({ error: "Could not save report email preference. Try again." }, { status: 500 });
  return NextResponse.json({ enabled: data.report_emails_enabled });
}
