import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProject, setActiveProject } from "@/lib/data";
import { isProvider, defaultModelFor } from "@/lib/models";
import { pickDefaultProvider } from "@/lib/trial";
import { humanError } from "@/lib/llm";
import type { Provider, Schedule } from "@/lib/types";

const SCHEDULES: Schedule[] = ["off", "daily", "weekly"];

function toAliases(value: unknown): string[] {
  const parts =
    Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(",")
        : [];
  return parts
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter((p) => p.length > 0);
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

  const b = (body ?? {}) as Record<string, unknown>;

  const name = typeof b.name === "string" ? b.name.trim() : "";
  const brand_name =
    typeof b.brand_name === "string" ? b.brand_name.trim() : "";

  if (!name) {
    return NextResponse.json(
      { error: "A workspace name is required" },
      { status: 400 },
    );
  }
  if (!brand_name) {
    return NextResponse.json(
      { error: "A brand name is required" },
      { status: 400 },
    );
  }

  // Provider/model are chosen automatically; only honor them if explicitly sent.
  const providerOverride: Provider | undefined =
    typeof b.default_provider === "string" && isProvider(b.default_provider)
      ? b.default_provider
      : undefined;
  const modelOverride =
    typeof b.default_model === "string" && b.default_model.trim().length > 0
      ? b.default_model.trim()
      : undefined;

  const schedule: Schedule =
    typeof b.schedule === "string" && SCHEDULES.includes(b.schedule as Schedule)
      ? (b.schedule as Schedule)
      : "off";

  const baseFields = {
    name,
    brand_name,
    brand_aliases: toAliases(b.brand_aliases),
    brand_domain: toNullableString(b.brand_domain),
    description: toNullableString(b.description),
    schedule,
  };

  try {
    const existing = await getProject(supabase, user.id);

    if (existing) {
      // Never reset the auto-chosen provider/model on a plain settings save.
      const update: Record<string, unknown> = {
        ...baseFields,
        updated_at: new Date().toISOString(),
      };
      if (providerOverride) update.default_provider = providerOverride;
      if (modelOverride) update.default_model = modelOverride;

      const { data, error } = await supabase
        .from("projects")
        .update(update)
        .eq("id", existing.id)
        .eq("user_id", user.id)
        .select("*")
        .single();

      if (error) {
        return NextResponse.json({ error: humanError(error) }, { status: 500 });
      }
      return NextResponse.json(data);
    }

    const insertProvider = providerOverride ?? pickDefaultProvider();
    const insertModel = modelOverride ?? defaultModelFor(insertProvider);
    const { data, error } = await supabase
      .from("projects")
      .insert({
        ...baseFields,
        default_provider: insertProvider,
        default_model: insertModel,
        user_id: user.id,
      })
      .select("*")
      .single();

    if (error) {
      return NextResponse.json({ error: humanError(error) }, { status: 500 });
    }
    await setActiveProject(supabase, user.id, (data as { id: string }).id);
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: humanError(e) }, { status: 500 });
  }
}
