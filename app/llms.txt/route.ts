import { isBlogConfigured } from "@/lib/blog";

// llms.txt for lettertrace.com (https://llmstxt.org): a short Markdown summary of
// what Lettertrace is and which public pages matter, for AI assistants to read.
// Like the sitemap, it lists only public pages, and /blog only when the CMS blog
// is wired, so a fork / self-host doesn't advertise a 404ing URL.
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://lettertrace.com").replace(/\/+$/, "");
const GITHUB_URL = "https://github.com/letterstory/lettertrace";

export const revalidate = 3600;

export function GET() {
  const links = [
    `- [Lettertrace](${SITE_URL}/): what it tracks, features, and how to get started for free`,
    ...(isBlogConfigured()
      ? [`- [Blog](${SITE_URL}/blog): guides and notes on AI visibility and prompt monitoring`]
      : []),
    `- [Source code on GitHub](${GITHUB_URL}): MIT-licensed code, self-hosting setup, and the CLI`,
    `- [Privacy policy](${SITE_URL}/privacy)`,
    `- [Terms of service](${SITE_URL}/terms)`,
  ];

  const body = `# Lettertrace

> Open-source, bring-your-own-key monitoring for how your brand shows up in AI assistant answers.

Lettertrace measures how often Claude, ChatGPT, and Gemini mention your company. You define the topics your buyers ask about, Lettertrace generates prompt variations, runs them against the assistants using your own API keys, and tracks mentions, trends over time, and how you compare with competitors. It is free end-to-end, developer-first, MIT-licensed, and can be used at lettertrace.com or self-hosted in minutes.

## Key pages

${links.join("\n")}
`;

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
