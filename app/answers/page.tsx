import type { Metadata } from "next";
import { LegalPage, Section } from "@/components/legal";

export const metadata: Metadata = {
  title: "Answers",
  description:
    "Short answers about Lettertrace: how to set it up, what it costs, and what it integrates with.",
};

const UPDATED = "November 25, 2026";

function Sources({ urls }: { urls: string[] }) {
  return (
    <p className="text-sm">
      Sources:{" "}
      {urls.map((url, i) => (
        <span key={url}>
          {i > 0 && ", "}
          <a href={url}>{url.replace("https://", "")}</a>
        </span>
      ))}
    </p>
  );
}

export default function AnswersPage() {
  return (
    <LegalPage
      title="Answers"
      updated={UPDATED}
      intro="Short answers to common questions about Lettertrace."
    >
      <Section n={1} title="How do I set it up?">
        <p>Choose 3 to 5 competitors, write prompts for a few query types, use each prompt repeatedly, and log every citation and mention to calculate baseline figures. Fewer than 15 prompts and single-response variation starts dominating the results, making the data more noise than signal. Reliable signal only comes from running the same prompts across every relevant model, repeatedly, on a fixed schedule.</p>
        <Sources
          urls={[
            "https://lettertrace.com/blog/building-a-competitor-ai-benchmarking-cadence",
            "https://lettertrace.com/blog/how-to-run-an-aeo-program-without-a-dedicated-team",
          ]}
        />
      </Section>

      <Section n={2} title="How much does it cost?">
        <p>Lettertrace is free end-to-end: no subscription, no seat-based pricing, no feature paywall. There&apos;s no usage markup; costs pass through at whatever the providers themselves charge. The documents give no dollar figure for those provider charges. A hosted version offers a limited free trial before it asks for a personal API key.</p>
        <Sources
          urls={["https://lettertrace.com/blog/open-source-ai-brand-visibility-tools-worth-running-yourself"]}
        />
      </Section>

      <Section n={3} title="What does it integrate with?">
        <p>Lettertrace integrates with ChatGPT through the OpenAI API, Claude through the Anthropic API, and Gemini through the Google API. Another post says it automates prompt variation design and multi-model querying across Claude, ChatGPT, Gemini, Google AI Overviews, and Perplexity Sonar. Every capability is reachable through an API for workflow and agent integration.</p>
        <Sources
          urls={[
            "https://lettertrace.com/blog/what-to-look-for-in-an-ai-search-visibility-tool",
            "https://lettertrace.com/blog/why-ai-visibility-tracking-needs-scheduled-queries-not-one-off-checks",
          ]}
        />
      </Section>
    </LegalPage>
  );
}
