import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/lib/data";
import { discoverCompanies } from "@/lib/discover";
import { humanError } from "@/lib/llm";
import type { Competitor } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Answers to scan. Enough to be representative, bounded so the scan stays
 *  cheap on a project with a long history. */
const ANSWER_LIMIT = 200;

// GET /api/competitors/discovered
// Companies the stored answers named that this project doesn't track.
//
// Reads text already in the database, so unlike /api/competitors/suggest this
// costs no provider call and needs no key: the recommendations the models
// already gave are sitting in `responses`, and mention detection throws away
// every name that isn't on the competitor list.
export async function GET() {
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

  try {
    const [{ data: responseRows }, { data: competitorRows }] = await Promise.all([
      supabase
        .from("responses")
        .select("response_text")
        .eq("project_id", project.id)
        .order("created_at", { ascending: false })
        .limit(ANSWER_LIMIT),
      supabase.from("competitors").select("name, aliases").eq("project_id", project.id),
    ]);

    const answers = ((responseRows ?? []) as { response_text: string | null }[])
      .map((r) => r.response_text ?? "")
      .filter(Boolean);

    // Everything already accounted for: the brand, its aliases, and every
    // tracked competitor with theirs. Leaving any of these in would offer the
    // user something they already track.
    const tracked = [
      project.brand_name,
      ...project.brand_aliases,
      ...((competitorRows ?? []) as Pick<Competitor, "name" | "aliases">[]).flatMap((c) => [
        c.name,
        ...c.aliases,
      ]),
    ];

    const companies = discoverCompanies(answers, tracked, { limit: 24 });

    return NextResponse.json({
      companies,
      answersScanned: answers.length,
      // A name in many answers is the category's default pick; a spread of
      // names appearing once each means the models have no consensus, which is
      // a different finding from losing to someone.
      topCount: companies[0]?.answers ?? 0,
    });
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
