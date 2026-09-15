import { describe, expect, it } from "vitest";
import {
  buildMultiReportEmail,
  buildSingleReportEmail,
  type MultiReportEmailInput,
  type SingleReportEmailInput,
} from "@/lib/report-email";

const BASE_URL = "https://lettertrace.com";

const SINGLE: SingleReportEmailInput = {
  brandName: "Acme",
  runId: "run-claude",
  providerLabel: "Anthropic (Claude)",
  modelLabel: "Claude Haiku 4.5",
  completedAnswers: 12,
  plannedAnswers: 12,
  brandMentionedAnswers: 5,
  visibility: 5 / 12,
  shareOfVoice: 0.23,
  sentiment: 0.62,
  topCompetitor: { name: "Globex", visibility: 0.31 },
  baseUrl: BASE_URL,
};

const MULTI: MultiReportEmailInput = {
  brandName: "Acme",
  requestedEngineCount: 4,
  reports: [
    {
      runId: "run-google",
      providerLabel: "Google (Gemini)",
      modelLabel: "Gemini Pro",
      visibility: 0.466,
      shareOfVoice: 0.18,
    },
    {
      runId: "run-anthropic",
      providerLabel: "Anthropic (Claude)",
      modelLabel: "Claude Haiku 4.5",
      visibility: 0.246,
      shareOfVoice: 0.23,
    },
    {
      runId: "run-perplexity",
      providerLabel: "Perplexity (Sonar)",
      modelLabel: "Sonar Pro",
      visibility: 0.236,
      shareOfVoice: 0.17,
    },
    {
      runId: "run-openai",
      providerLabel: "OpenAI (ChatGPT)",
      modelLabel: "GPT-4o mini",
      visibility: 0.176,
      shareOfVoice: 0.09,
    },
  ],
  failures: [],
  baseUrl: BASE_URL,
};

describe("buildSingleReportEmail", () => {
  it("names the brand, visibility, and model in the subject", () => {
    expect(buildSingleReportEmail(SINGLE).subject).toBe(
      "Acme: 42% brand visibility on Claude Haiku 4.5",
    );
  });

  it("renders the four approved report measurements in html and text", () => {
    const email = buildSingleReportEmail(SINGLE);
    for (const value of ["Brand visibility", "42%", "5 of 12 answers", "Share of voice", "23%", "Sentiment", "0.62", "Top competitor", "Globex", "31% visibility"]) {
      expect(email.html).toContain(value);
      expect(email.text).toContain(value);
    }
  });

  it("links the CTA to the individual run and normalizes a trailing slash", () => {
    const email = buildSingleReportEmail({ ...SINGLE, baseUrl: `${BASE_URL}/` });
    expect(email.html).toContain('href="https://lettertrace.com/dashboard/runs/run-claude"');
    expect(email.text).toContain("https://lettertrace.com/dashboard/runs/run-claude");
    expect(email.html).not.toContain(".com//dashboard");
  });

  it("escapes dynamic markup and encodes an unsafe run id as a path segment", () => {
    const email = buildSingleReportEmail({
      ...SINGLE,
      brandName: '<script>alert("brand")</script>',
      runId: "run/one?<script>",
      topCompetitor: { name: "A & B <Co>", visibility: 0.5 },
    });
    expect(email.html).not.toContain('<script>alert("brand")</script>');
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("A &amp; B &lt;Co&gt;");
    expect(email.html).toContain("run%2Fone%3F%3Cscript%3E");
  });

  it("never prints non-finite values as NaN or undefined", () => {
    const email = buildSingleReportEmail({
      ...SINGLE,
      visibility: Number.NaN,
      shareOfVoice: Number.POSITIVE_INFINITY,
      sentiment: Number.NaN,
      topCompetitor: null,
    });
    expect(email.html).toContain("n/a");
    expect(`${email.subject}${email.html}${email.text}`).not.toMatch(/NaN|undefined/);
  });

  it("refuses a non-http base URL instead of rendering a dangerous link", () => {
    expect(() => buildSingleReportEmail({ ...SINGLE, baseUrl: "javascript:alert(1)" })).toThrow(
      "absolute http(s) URL",
    );
  });
});

describe("buildMultiReportEmail", () => {
  it("averages the raw engine values before rounding the 28% rollup", () => {
    const email = buildMultiReportEmail(MULTI);
    // Averaging the displayed 47, 25, 24, and 18 first would round to 29%.
    // The dashboard averages the underlying measurements, so the mail must too.
    expect(email.subject).toBe("Acme: 28% overall AI visibility across 4 engines");
    expect(email.html).toContain("Overall AI visibility");
    expect(email.text).toContain("Overall AI visibility: 28%");
  });

  it("sorts cards by visibility without mutating the caller's report order", () => {
    const input = { ...MULTI, reports: [...MULTI.reports].reverse() };
    const original = input.reports.map((report) => report.runId);
    const email = buildMultiReportEmail(input);
    expect(email.html.indexOf("Google (Gemini)")).toBeLessThan(
      email.html.indexOf("Anthropic (Claude)"),
    );
    expect(email.html.indexOf("Anthropic (Claude)")).toBeLessThan(
      email.html.indexOf("Perplexity (Sonar)"),
    );
    expect(input.reports.map((report) => report.runId)).toEqual(original);
  });

  it("links every card to its run and the main CTA to all reports", () => {
    const email = buildMultiReportEmail(MULTI);
    for (const report of MULTI.reports) {
      expect(email.html).toContain(
        `href="https://lettertrace.com/dashboard/runs/${report.runId}"`,
      );
      expect(email.text).toContain(`https://lettertrace.com/dashboard/runs/${report.runId}`);
    }
    expect(email.html).toContain('href="https://lettertrace.com/dashboard/runs"');
    expect(email.text).toContain("View all reports: https://lettertrace.com/dashboard/runs");
  });

  it("averages successful reports only and identifies a partial failure", () => {
    const email = buildMultiReportEmail({
      ...MULTI,
      reports: MULTI.reports.slice(0, 3),
      failures: [{ providerLabel: "OpenAI (ChatGPT)", modelLabel: "GPT-4o mini" }],
    });
    expect(email.subject).toBe("Acme: 32% overall AI visibility across 3 engines");
    expect(email.html).toContain("3 completed engines; 1 engine didn’t finish.");
    expect(email.text).toContain("Didn't finish: OpenAI (ChatGPT) (GPT-4o mini)");
    expect(email.html).not.toContain("OpenAI request failed");
  });

  it("keeps the multi layout when only one of several requested engines succeeds", () => {
    const email = buildMultiReportEmail({
      ...MULTI,
      reports: MULTI.reports.slice(0, 1),
      failures: MULTI.reports.slice(1).map((report) => ({
        providerLabel: report.providerLabel,
        modelLabel: report.modelLabel,
      })),
    });
    expect(email.html).toContain("Overall AI visibility");
    expect(email.html).toContain("1 completed engine; 3 engines didn’t finish.");
    expect(email.subject).toContain("across 1 engine");
  });

  it("renders an all-failed action email with no fabricated percentage", () => {
    const email = buildMultiReportEmail({
      ...MULTI,
      reports: [],
      failures: MULTI.reports.map((report) => ({ providerLabel: report.providerLabel })),
    });
    expect(email.subject).toBe("Acme: your reports didn't finish");
    expect(email.html).toContain("Review reports");
    expect(email.text).toContain("couldn't complete any of the 4 engines");
    expect(`${email.subject}${email.text}`).not.toContain("%");
    expect(email.html).not.toMatch(/>\s*\d+%\s*</);
    expect(email.html).not.toContain("Overall AI visibility");
  });

  it("escapes failure labels rather than exposing markup", () => {
    const email = buildMultiReportEmail({
      ...MULTI,
      reports: MULTI.reports.slice(0, 3),
      failures: [{ providerLabel: "<script>bad</script>" }],
    });
    expect(email.html).not.toContain("<script>bad</script>");
    expect(email.html).toContain("&lt;script&gt;bad&lt;/script&gt;");
  });

  it("requires every requested engine to have a terminal outcome", () => {
    expect(() =>
      buildMultiReportEmail({ ...MULTI, reports: MULTI.reports.slice(0, 3) }),
    ).toThrow("describe every requested engine");
    expect(() => buildMultiReportEmail({ ...MULTI, requestedEngineCount: 1 })).toThrow(
      "at least two requested engines",
    );
  });

  it("ships a dark, responsive document and a non-empty text alternative", () => {
    const email = buildMultiReportEmail(MULTI);
    expect(email.html).toContain('content="dark"');
    expect(email.html).toContain("@media only screen and (max-width: 620px)");
    expect(email.html).toContain("#11100F");
    expect(email.text.trim().length).toBeGreaterThan(0);
    expect(`${email.subject}${email.html}${email.text}`).not.toMatch(/NaN|undefined/);
  });
});
