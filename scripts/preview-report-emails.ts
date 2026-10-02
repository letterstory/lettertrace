/**
 * Build every approved report-email state from deterministic fixture data.
 * The output stays under ignored .pilot/ and performs no network or database I/O.
 *
 *   npx vite-node scripts/preview-report-emails.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildMultiReportEmail,
  buildSingleReportEmail,
  type MultiReportEmailInput,
} from "../lib/report-email";

const baseUrl = "https://lettertrace.com";
const outputDir = resolve(process.cwd(), ".pilot", "report-email-previews");

const reports: MultiReportEmailInput["reports"] = [
  {
    runId: "preview-google",
    providerLabel: "Google (Gemini)",
    modelLabel: "Gemini Pro",
    visibility: 0.466,
    shareOfVoice: 0.18,
  },
  {
    runId: "preview-anthropic",
    providerLabel: "Anthropic (Claude)",
    modelLabel: "Claude Haiku 4.5",
    visibility: 0.246,
    shareOfVoice: 0.23,
  },
  {
    runId: "preview-perplexity",
    providerLabel: "Perplexity (Sonar)",
    modelLabel: "Sonar Pro",
    visibility: 0.236,
    shareOfVoice: 0.17,
  },
  {
    runId: "preview-openai",
    providerLabel: "OpenAI (ChatGPT)",
    modelLabel: "GPT-4o mini",
    visibility: 0.176,
    shareOfVoice: 0.09,
  },
];

const multiBase: MultiReportEmailInput = {
  brandName: "Acme",
  requestedEngineCount: reports.length,
  reports,
  failures: [],
  baseUrl,
};

const previews = [
  {
    filename: "single-success.html",
    email: buildSingleReportEmail({
      brandName: "Acme",
      runId: "preview-anthropic",
      providerLabel: "Anthropic (Claude)",
      modelLabel: "Claude Haiku 4.5",
      completedAnswers: 12,
      plannedAnswers: 12,
      brandMentionedAnswers: 5,
      visibility: 5 / 12,
      shareOfVoice: 0.23,
      sentiment: 0.62,
      topCompetitor: { name: "Globex", visibility: 0.31 },
      baseUrl,
    }),
  },
  { filename: "multi-success.html", email: buildMultiReportEmail(multiBase) },
  {
    filename: "multi-partial-failure.html",
    email: buildMultiReportEmail({
      ...multiBase,
      reports: reports.slice(0, 3),
      failures: [{ providerLabel: "OpenAI (ChatGPT)", modelLabel: "GPT-4o mini" }],
    }),
  },
  {
    filename: "all-failed.html",
    email: buildMultiReportEmail({
      ...multiBase,
      reports: [],
      failures: reports.map((report) => ({
        providerLabel: report.providerLabel,
        modelLabel: report.modelLabel,
      })),
    }),
  },
];

mkdirSync(outputDir, { recursive: true });
for (const preview of previews) {
  const output = resolve(outputDir, preview.filename);
  writeFileSync(output, preview.email.html, "utf8");
  console.log(`${preview.filename}\n  ${preview.email.subject}\n  ${output}`);
}
