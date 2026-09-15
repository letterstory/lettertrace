// Pure presentation builders for report emails. They accept display-ready
// measurements and produce no I/O, so approving a template cannot silently
// change how a report is calculated or start sending mail.

export interface ReportEmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface SingleReportEmailInput {
  brandName: string;
  runId: string;
  providerLabel: string;
  modelLabel: string;
  completedAnswers: number;
  plannedAnswers: number;
  brandMentionedAnswers: number;
  visibility: number;
  shareOfVoice: number;
  sentiment: number | null;
  topCompetitor: { name: string; visibility: number } | null;
  baseUrl: string;
}

export interface ReportEmailEngine {
  runId: string;
  providerLabel: string;
  modelLabel: string;
  visibility: number;
  shareOfVoice: number;
}

export interface ReportEmailFailure {
  providerLabel: string;
  modelLabel?: string;
}

export interface MultiReportEmailInput {
  brandName: string;
  requestedEngineCount: number;
  reports: ReportEmailEngine[];
  failures: ReportEmailFailure[];
  baseUrl: string;
}

const COLORS = {
  canvas: "#11100F",
  panel: "#1B1917",
  card: "#211F1C",
  border: "#3A3631",
  ink: "#F7F4EE",
  soft: "#C6C0B7",
  faint: "#918B83",
  terracotta: "#E07850",
  teal: "#2AB69B",
  mint: "#A8F0DC",
  sand: "#CBB9A0",
  warningBg: "#2A211D",
  warningBorder: "#704733",
  warningInk: "#F3C2A8",
} as const;

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF_STACK = "Georgia,'Times New Roman',serif";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

function subjectText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function percentage(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : "n/a";
}

function sentiment(value: number | null): string {
  return value !== null && Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function appUrl(baseUrl: string, path: string): string {
  let base: URL;
  try {
    base = new URL(baseUrl.trim());
  } catch {
    throw new Error("Report email baseUrl must be an absolute http(s) URL.");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("Report email baseUrl must be an absolute http(s) URL.");
  }
  return new URL(path, `${base.origin}/`).toString();
}

function runUrl(baseUrl: string, runId: string): string {
  return appUrl(baseUrl, `/dashboard/runs/${encodeURIComponent(runId)}`);
}

function reportsUrl(baseUrl: string): string {
  return appUrl(baseUrl, "/dashboard/runs");
}

function settingsUrl(baseUrl: string): string {
  return appUrl(baseUrl, "/dashboard/settings");
}

function wrapHtml(preheader: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>${escapeHtml(preheader)}</title>
  <style>
    body { margin: 0 !important; padding: 0 !important; background: ${COLORS.canvas} !important; }
    table { border-collapse: collapse; border-spacing: 0; }
    a { color: inherit; }
    @media only screen and (max-width: 620px) {
      .email-shell { width: 100% !important; max-width: 100% !important; table-layout: fixed !important; }
      .email-pad { padding: 24px 16px !important; }
      .email-content { padding: 24px 20px !important; overflow-wrap: anywhere !important; }
      .stack-column { display: block !important; width: 100% !important; padding-left: 0 !important; padding-right: 0 !important; }
      .overall-layout, .overall-layout tbody, .overall-row, .overall-copy { display: block !important; width: 100% !important; }
      .overall-value { display: block !important; width: 100% !important; padding-top: 12px !important; text-align: left !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${COLORS.canvas};color:${COLORS.ink};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:${COLORS.canvas};">
    <tr>
      <td class="email-pad" align="center" style="padding:36px 20px;">
        <table class="email-shell" role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:640px;background:${COLORS.panel};border:1px solid ${COLORS.border};">
          <tr><td class="email-content" style="padding:32px;font-family:${FONT_STACK};color:${COLORS.ink};">${body}</td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function ctaHtml(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px;">
  <tr><td style="background:${COLORS.terracotta};">
    <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;font-family:${FONT_STACK};font-size:14px;font-weight:700;line-height:20px;color:${COLORS.canvas};text-decoration:none;">${escapeHtml(label)}</a>
  </td></tr>
</table>`;
}

function footerHtml(baseUrl: string): string {
  const url = settingsUrl(baseUrl);
  return `<p style="margin:28px 0 0;font-family:${FONT_STACK};font-size:12px;line-height:18px;color:${COLORS.faint};">Manage report emails in <a href="${escapeHtml(url)}" style="color:${COLORS.soft};text-decoration:underline;">Lettertrace settings</a>.</p>`;
}

interface StatCard {
  label: string;
  value: string;
  hint: string;
  accent: string;
}

function statCardHtml(stat: StatCard): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:${COLORS.card};border:1px solid ${COLORS.border};">
  <tr><td style="padding:18px;">
    <p style="margin:0;font-family:${FONT_STACK};font-size:13px;line-height:18px;color:${COLORS.soft};"><span style="color:${stat.accent};">■</span>&nbsp;&nbsp;${escapeHtml(stat.label)}</p>
    <p style="margin:8px 0 0;font-family:${FONT_STACK};font-size:28px;font-weight:650;line-height:34px;color:${COLORS.ink};">${escapeHtml(stat.value)}</p>
    <p style="margin:4px 0 0;font-family:${FONT_STACK};font-size:12px;line-height:18px;color:${COLORS.faint};">${escapeHtml(stat.hint)}</p>
  </td></tr>
</table>`;
}

function twoColumnGrid(items: string[]): string {
  const rows: string[] = [];
  for (let index = 0; index < items.length; index += 2) {
    const left = items[index];
    const right = items[index + 1];
    rows.push(`<tr>
  <td class="stack-column" width="50%" valign="top" style="width:50%;padding:0 6px 12px 0;">${left}</td>
  ${
    right
      ? `<td class="stack-column" width="50%" valign="top" style="width:50%;padding:0 0 12px 6px;">${right}</td>`
      : `<td class="stack-column" width="50%" style="width:50%;"></td>`
  }
</tr>`);
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;">${rows.join("")}</table>`;
}

export function buildSingleReportEmail(input: SingleReportEmailInput): ReportEmailContent {
  const url = runUrl(input.baseUrl, input.runId);
  const visibility = percentage(input.visibility);
  const completed = Math.max(0, Math.trunc(input.completedAnswers));
  const planned = Math.max(0, Math.trunc(input.plannedAnswers));
  const mentioned = Math.max(0, Math.trunc(input.brandMentionedAnswers));
  const answerCopy = `${completed} of ${planned} ${planned === 1 ? "answer" : "answers"}`;
  const topCompetitor = input.topCompetitor;
  const stats: StatCard[] = [
    {
      label: "Brand visibility",
      value: visibility,
      hint: `${mentioned} of ${countLabel(completed, "answer")}`,
      accent: COLORS.terracotta,
    },
    {
      label: "Share of voice",
      value: percentage(input.shareOfVoice),
      hint: "Of all brand + competitor mentions",
      accent: COLORS.teal,
    },
    {
      label: "Sentiment",
      value: sentiment(input.sentiment),
      hint: "-1 to +1 across mentions",
      accent: COLORS.mint,
    },
    {
      label: "Top competitor",
      value: topCompetitor?.name ?? "None",
      hint: topCompetitor
        ? `${percentage(topCompetitor.visibility)} visibility`
        : "No competitors mentioned",
      accent: COLORS.sand,
    },
  ];

  const body = `<p style="margin:0 0 8px;font-family:${FONT_STACK};font-size:12px;font-weight:700;line-height:18px;letter-spacing:.08em;text-transform:uppercase;color:${COLORS.faint};">${escapeHtml(input.providerLabel)}</p>
<h1 style="margin:0;font-family:${SERIF_STACK};font-size:28px;font-weight:400;line-height:34px;color:${COLORS.ink};">${escapeHtml(input.brandName)} report</h1>
<p style="margin:8px 0 24px;font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${COLORS.soft};">${escapeHtml(input.modelLabel)} · ${escapeHtml(answerCopy)}</p>
${twoColumnGrid(stats.map(statCardHtml))}
${ctaHtml("View the full report", url)}
${footerHtml(input.baseUrl)}`;

  const text = [
    `${input.brandName} report`,
    `${input.providerLabel} · ${input.modelLabel} · ${answerCopy}`,
    "",
    `Brand visibility: ${visibility} (${mentioned} of ${countLabel(completed, "answer")})`,
    `Share of voice: ${percentage(input.shareOfVoice)} (of all brand + competitor mentions)`,
    `Sentiment: ${sentiment(input.sentiment)} (-1 to +1 across mentions)`,
    topCompetitor
      ? `Top competitor: ${topCompetitor.name} (${percentage(topCompetitor.visibility)} visibility)`
      : "Top competitor: None (no competitors mentioned)",
    "",
    `View the full report: ${url}`,
    `Manage report emails: ${settingsUrl(input.baseUrl)}`,
  ].join("\n");

  return {
    subject: subjectText(`${input.brandName}: ${visibility} brand visibility on ${input.modelLabel}`),
    html: wrapHtml(`${input.brandName}: ${visibility} brand visibility`, body),
    text,
  };
}

function averageVisibility(reports: ReportEmailEngine[]): number | null {
  if (reports.length === 0 || reports.some((report) => !Number.isFinite(report.visibility))) {
    return null;
  }
  return reports.reduce((total, report) => total + report.visibility, 0) / reports.length;
}

function engineCardHtml(report: ReportEmailEngine, baseUrl: string): string {
  const url = runUrl(baseUrl, report.runId);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:${COLORS.card};border:1px solid ${COLORS.border};word-break:break-word;">
  <tr><td>
    <a href="${escapeHtml(url)}" style="display:block;padding:18px;font-family:${FONT_STACK};color:${COLORS.ink};text-decoration:none;">
      <span style="display:block;font-size:12px;font-weight:700;line-height:18px;letter-spacing:.06em;text-transform:uppercase;color:${COLORS.faint};">${escapeHtml(report.providerLabel)}</span>
      <span style="display:block;margin-top:8px;font-size:28px;font-weight:650;line-height:34px;color:${COLORS.ink};">${escapeHtml(percentage(report.visibility))}</span>
      <span style="display:block;margin-top:5px;font-size:13px;line-height:19px;color:${COLORS.soft};">Share of voice ${escapeHtml(percentage(report.shareOfVoice))}</span>
      <span style="display:block;margin-top:3px;font-size:12px;line-height:18px;color:${COLORS.faint};">${escapeHtml(report.modelLabel)} · View report →</span>
    </a>
  </td></tr>
</table>`;
}

function failureLabel(failure: ReportEmailFailure): string {
  return failure.modelLabel
    ? `${failure.providerLabel} (${failure.modelLabel})`
    : failure.providerLabel;
}

function allFailedEmail(input: MultiReportEmailInput): ReportEmailContent {
  const url = reportsUrl(input.baseUrl);
  const engineCopy = countLabel(input.requestedEngineCount, "engine");
  const labels = input.failures.map(failureLabel);
  const body = `<p style="margin:0 0 8px;font-family:${FONT_STACK};font-size:12px;font-weight:700;line-height:18px;letter-spacing:.08em;text-transform:uppercase;color:${COLORS.warningInk};">Report update</p>
<h1 style="margin:0;font-family:${SERIF_STACK};font-size:28px;font-weight:400;line-height:34px;color:${COLORS.ink};">${escapeHtml(input.brandName)} reports didn&#39;t finish</h1>
<p style="margin:12px 0 0;font-family:${FONT_STACK};font-size:14px;line-height:22px;color:${COLORS.soft};">We couldn&#39;t complete any of the ${escapeHtml(engineCopy)} in this batch. Open Reports to review what happened and try again.</p>
${
  labels.length > 0
    ? `<p style="margin:20px 0 0;padding:14px 16px;background:${COLORS.warningBg};border:1px solid ${COLORS.warningBorder};font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${COLORS.warningInk};word-break:break-word;">Didn&#39;t finish: ${escapeHtml(labels.join(", "))}</p>`
    : ""
}
${ctaHtml("Review reports", url)}
${footerHtml(input.baseUrl)}`;
  const text = [
    `${input.brandName} reports didn't finish`,
    "",
    `We couldn't complete any of the ${engineCopy} in this batch.`,
    labels.length > 0 ? `Didn't finish: ${labels.join(", ")}` : "",
    "",
    `Review reports and try again: ${url}`,
    `Manage report emails: ${settingsUrl(input.baseUrl)}`,
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n");
  return {
    subject: subjectText(`${input.brandName}: your reports didn't finish`),
    html: wrapHtml(`${input.brandName}: your reports didn't finish`, body),
    text,
  };
}

export function buildMultiReportEmail(input: MultiReportEmailInput): ReportEmailContent {
  if (!Number.isInteger(input.requestedEngineCount) || input.requestedEngineCount < 2) {
    throw new Error("A multi-report email requires at least two requested engines.");
  }
  if (input.reports.length + input.failures.length !== input.requestedEngineCount) {
    throw new Error("A multi-report email must describe every requested engine as completed or failed.");
  }
  if (input.reports.length === 0) return allFailedEmail(input);

  const reports = [...input.reports].sort((left, right) => right.visibility - left.visibility);
  const overall = percentage(averageVisibility(reports) ?? Number.NaN);
  const successCount = reports.length;
  const failureCount = input.failures.length;
  const summary = failureCount > 0
    ? `${countLabel(successCount, "completed engine")}; ${countLabel(failureCount, "engine")} didn’t finish.`
    : `Average across ${countLabel(successCount, "engine")} in this batch.`;
  const failureLabels = input.failures.map(failureLabel);
  const allReportsUrl = reportsUrl(input.baseUrl);

  const body = `<p style="margin:0 0 8px;font-family:${FONT_STACK};font-size:12px;font-weight:700;line-height:18px;letter-spacing:.08em;text-transform:uppercase;color:${COLORS.faint};">${escapeHtml(input.brandName)} reports</p>
<table class="overall-layout" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;">
  <tr class="overall-row">
    <td class="overall-copy" valign="top">
      <h1 style="margin:0;font-family:${SERIF_STACK};font-size:28px;font-weight:400;line-height:34px;color:${COLORS.ink};">Overall AI visibility</h1>
      <p style="margin:7px 0 0;font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${COLORS.soft};">${escapeHtml(summary)}</p>
    </td>
    <td class="overall-value" width="120" valign="top" align="right" style="width:120px;padding-left:20px;font-family:${FONT_STACK};font-size:42px;font-weight:650;line-height:46px;color:${COLORS.ink};">${escapeHtml(overall)}</td>
  </tr>
</table>
<div style="height:22px;line-height:22px;">&nbsp;</div>
${twoColumnGrid(reports.map((report) => engineCardHtml(report, input.baseUrl)))}
${
  failureCount > 0
    ? `<p style="margin:8px 0 0;padding:14px 16px;background:${COLORS.warningBg};border:1px solid ${COLORS.warningBorder};font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${COLORS.warningInk};word-break:break-word;">Didn&#39;t finish: ${escapeHtml(failureLabels.join(", "))}. Open Reports to review what happened.</p>`
    : ""
}
${ctaHtml("View all reports", allReportsUrl)}
${footerHtml(input.baseUrl)}`;

  const reportLines = reports.flatMap((report) => [
    report.providerLabel,
    `Brand visibility: ${percentage(report.visibility)}`,
    `Share of voice: ${percentage(report.shareOfVoice)}`,
    `Model: ${report.modelLabel}`,
    `View report: ${runUrl(input.baseUrl, report.runId)}`,
    "",
  ]);
  const text = [
    `${input.brandName} reports`,
    `Overall AI visibility: ${overall}`,
    summary,
    "",
    ...reportLines,
    failureCount > 0 ? `Didn't finish: ${failureLabels.join(", ")}` : "",
    failureCount > 0 ? "Open Reports to review what happened." : "",
    "",
    `View all reports: ${allReportsUrl}`,
    `Manage report emails: ${settingsUrl(input.baseUrl)}`,
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n")
    .trim();

  return {
    subject: subjectText(
      `${input.brandName}: ${overall} overall AI visibility across ${countLabel(successCount, "engine")}`,
    ),
    html: wrapHtml(`${input.brandName}: ${overall} overall AI visibility`, body),
    text,
  };
}
