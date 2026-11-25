import type { Metadata } from "next";
import { LegalPage, Section } from "@/components/legal";

export const metadata: Metadata = {
  title: "Answers",
  description:
    "Short answers about Lettertrace: what it integrates with, how to set it up, its limits, and how it handles security and your data.",
};

const UPDATED = "November 25, 2026";

export default function AnswersPage() {
  return (
    <LegalPage
      title="Answers"
      updated={UPDATED}
      intro="Short answers to common questions about Lettertrace."
    >
      <Section n={1} title="What does it integrate with?">
        <p>Lettertrace queries Claude (Anthropic), ChatGPT (OpenAI), Gemini and Google AI Overviews (both on a Google key) and Perplexity Sonar, using your own provider keys, or a single LLM router key (Concentrate) instead. It also has a REST API, a command-line client and an MCP server (Streamable HTTP) so Claude and other MCP clients can read your share-of-voice data. Storage and sign-in run on Supabase, and Google and GitHub sign-in are optional.</p>
      </Section>

      <Section n={2} title="How is it installed or set up?">
        <p>Use the hosted app at lettertrace.com, or self-host it: create a Supabase project, apply the supabase/schema.sql file, copy .env.example and fill in the Supabase values and an encryption key, then run it with npm or the published Docker image (ghcr.io/letterstory/lettertrace). Add your provider key in Settings, describe your brand, add competitors and topics, generate prompt variations, and click Run monitor now. Scheduled runs use a cron endpoint, which Vercel schedules daily and which you can call from your own cron elsewhere.</p>
      </Section>

      <Section n={3} title="What are its limits?">
        <p>It measures a sample of AI answers, not every answer, and answers vary between identical calls, so you can set replicates (1 to 10) to ask each prompt several times and narrow the interval. Where the free trial is offered, each user gets a limited number of free runs (15 by default, and each engine in a sweep counts as one run) before adding their own key. Runs query up to 8 prompts at a time (4 for Perplexity) to stay inside provider rate limits, and Node 20 to 22 is required to self-host.</p>
      </Section>

      <Section n={4} title="How does it handle security and customers' data?">
        <p>Provider API keys are encrypted at rest with AES-256-GCM and decrypted only in memory when a run executes, and Lettertrace API keys are stored only as SHA-256 hashes. Each account&apos;s data is isolated by Postgres Row Level Security, and traffic to lettertrace.com is encrypted in transit over TLS. Your monitoring data lives in your own Supabase database when you self-host, and no system is perfectly secure.</p>
      </Section>
    </LegalPage>
  );
}
