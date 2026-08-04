import crypto from "node:crypto";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * RB2B website-visitor webhook -> Slack.
 *
 * RB2B de-anonymizes site traffic and POSTs one JSON payload per identified
 * visitor to a single URL you configure in their dashboard (Integrations ->
 * Webhook). RB2B cannot send custom headers, so the only auth it supports is a
 * query parameter baked into the URL — we require ?secret=$RB2B_WEBHOOK_SECRET
 * and compare it in constant time so it can't be probed by timing.
 *
 * The full URL you paste into RB2B looks like:
 *   https://lettertrace.com/api/rb2b?secret=<RB2B_WEBHOOK_SECRET>
 *
 * Payload field names are fixed by RB2B and contain spaces (e.g. "First Name").
 * Company-only profiles arrive with no person fields; we still forward those.
 */

// RB2B's documented payload. Every field can be absent/null, so treat all as
// optional and defensive — RB2B owns this shape and we can't change it.
interface RB2BPayload {
  "LinkedIn URL"?: string | null;
  "First Name"?: string | null;
  "Last Name"?: string | null;
  Title?: string | null;
  "Company Name"?: string | null;
  "Business Email"?: string | null;
  Website?: string | null;
  Industry?: string | null;
  "Employee Count"?: number | null;
  "Estimate Revenue"?: string | null;
  City?: string | null;
  State?: string | null;
  Zipcode?: string | null;
  "Seen At"?: string | null;
  Referrer?: string | null;
  "Captured URL"?: string | null;
  Tags?: string | null;
}

function authorized(request: Request): boolean {
  const secret = process.env.RB2B_WEBHOOK_SECRET;
  if (!secret) return false;
  const provided = new URL(request.url).searchParams.get("secret") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Turn one RB2B visitor into a Slack Block Kit message. */
function toSlackMessage(v: RB2BPayload) {
  const name = [v["First Name"], v["Last Name"]].filter(nonEmpty).join(" ").trim();
  const person = name || v["Business Email"] || "Someone";
  const company = nonEmpty(v["Company Name"]) ? v["Company Name"] : null;
  const headline = company ? `${person} from ${company}` : person;

  // Compact "label: value" fields, only those RB2B actually filled in.
  const fields: string[] = [];
  const push = (label: string, value: unknown, fmt?: (s: string) => string) => {
    if (nonEmpty(value)) fields.push(`*${label}:* ${fmt ? fmt(value) : value}`);
    else if (typeof value === "number") fields.push(`*${label}:* ${value}`);
  };
  push("Title", v.Title);
  push("Email", v["Business Email"]);
  push("Location", [v.City, v.State].filter(nonEmpty).join(", "));
  push("Industry", v.Industry);
  push("Employees", v["Employee Count"]);
  push("Revenue", v["Estimate Revenue"]);
  push("Page", v["Captured URL"], (s) => `<${s}|${s.replace(/^https?:\/\//, "")}>`);
  push("Referrer", v.Referrer);
  push("Tags", v.Tags);

  const linkedin = nonEmpty(v["LinkedIn URL"])
    ? `<${v["LinkedIn URL"]}|View LinkedIn profile>`
    : null;

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `👤 ${headline}`, emoji: true },
    },
  ];
  if (fields.length) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: fields.join("\n") },
    });
  }
  if (linkedin) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: linkedin } });
  }
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Identified by RB2B${nonEmpty(v["Seen At"]) ? ` · ${v["Seen At"]}` : ""}`,
      },
    ],
  });

  // `text` is the notification/fallback shown in the Slack sidebar & pushes.
  return { text: `New visitor: ${headline}`, blocks };
}

async function postToSlack(message: unknown): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) throw new Error("SLACK_WEBHOOK_URL is not set");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
  });
  if (!res.ok) {
    throw new Error(`Slack responded ${res.status}: ${await res.text()}`);
  }
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: RB2BPayload;
  try {
    payload = (await request.json()) as RB2BPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    await postToSlack(toSlackMessage(payload));
  } catch (e) {
    // Surface the failure so RB2B's "Send a Test Event" shows red and their
    // retry logic can try again, rather than silently dropping a lead.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to notify Slack" },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}
