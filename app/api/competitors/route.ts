import { NextResponse } from "next/server";
import { getProject } from "@/lib/data";
import { humanError } from "@/lib/llm";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await getProject(supabase, user.id);
  if (!project) {
    return NextResponse.json({ error: "Create a project first" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const payload = (body ?? {}) as {
    name?: unknown;
    aliases?: unknown;
    domain?: unknown;
  };

  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const aliases = Array.isArray(payload.aliases)
    ? payload.aliases
        .map((a) => (typeof a === "string" ? a.trim() : ""))
        .filter((a) => a.length > 0)
    : typeof payload.aliases === "string"
      ? payload.aliases
          .split(",")
          .map((a) => a.trim())
          .filter((a) => a.length > 0)
      : [];

  const domain =
    typeof payload.domain === "string" && payload.domain.trim().length > 0
      ? payload.domain.trim()
      : null;

  try {
    const { data, error } = await supabase
      .from("competitors")
      .insert({
        project_id: project.id,
        name,
        aliases,
        domain,
      })
      .select("*")
      .single();

    if (error) {
      // 23505 = the competitors_project_name_uniq index. Adding the same
      // competitor twice is a user-visible conflict, not a server fault.
      if (error.code === "23505") {
        return NextResponse.json(
          { error: `"${name}" is already tracked as a competitor.` },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
