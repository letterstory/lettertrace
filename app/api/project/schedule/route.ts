import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";
import { humanError } from "@/lib/llm";
import { logDashboard } from "@/lib/activity";
import type { Schedule } from "@/lib/types";

const SCHEDULES: Schedule[] = ["off", "daily", "weekly"];

// Schedule-only write, so the Runs page can offer the toggle where people
// actually go looking for it. POST /api/project is a full-form upsert —
// requires name and brand_name, and rewrites aliases, domains and description
// from the body — so a control that only wants to flip the schedule can't
// safely go through it.
export async function PATCH(request: Request) {
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
  const schedule = (body as { schedule?: unknown } | null)?.schedule;
  if (typeof schedule !== "string" || !SCHEDULES.includes(schedule as Schedule)) {
    return NextResponse.json(
      { error: "schedule must be one of off, daily or weekly" },
      { status: 400 },
    );
  }

  try {
    const project = await getProject(supabase, user.id);
    if (!project) {
      return NextResponse.json({ error: "No project yet" }, { status: 404 });
    }

    const { data, error } = await supabase
      .from("projects")
      .update({ schedule, updated_at: new Date().toISOString() })
      .eq("id", project.id)
      .eq("user_id", user.id)
      .select("*")
      .single();

    if (error) {
      return NextResponse.json({ error: humanError(error) }, { status: 500 });
    }

    await logDashboard(user, request, {
      category: "project",
      action: "project.updated",
      summary: `Set monitoring schedule to ${schedule}`,
      projectId: project.id,
      targetType: "project",
      targetId: project.id,
      metadata: { schedule },
    });
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
