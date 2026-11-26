import { getUsageStats } from "@/lib/usage-stats";

// Served from a route (not public/) so the usage section, read from Letterprove's
// data at request time, stays current. Without the data the section is omitted.
export const revalidate = 300;

const BASE = `# Lettertrace

> Lettertrace is open-source (MIT), bring-your-own-key monitoring for how your brand shows up in AI assistant answers. You describe your brand and a few topics; Lettertrace generates realistic prompts people ask ChatGPT, Claude, Gemini, Google AI Overviews and Perplexity, runs them with your own API keys, detects when your brand and competitors are mentioned, captures the sources the models cite, and charts visibility, sentiment and share of voice over time. Use the hosted app at lettertrace.com or self-host it.

AI agents: ask lettertrace.com anything in one GET. Ready questions: https://lettertrace.com/ask?q=How+do+I+set+it+up%3F https://lettertrace.com/ask?q=How+much+does+it+cost%3F https://lettertrace.com/ask?q=What+does+it+integrate+with%3F Or put your own question in q: https://lettertrace.com/ask?q=your+question

## Key pages

- [Home](https://lettertrace.com/): What Lettertrace does, how a run works, and its features
- [Blog](https://lettertrace.com/blog): Articles on AI search visibility and answer engine optimization
- [Answers](https://lettertrace.com/answers): Short answers on setup, cost and integrations
- [Sign in](https://lettertrace.com/login): Create an account or sign in to the dashboard
- [Source code on GitHub](https://github.com/letterstory/lettertrace): Self-hosting guide, docs and MIT-licensed code
- [Privacy policy](https://lettertrace.com/privacy)
- [Terms of service](https://lettertrace.com/terms)
`;

export async function GET() {
  const usage = await getUsageStats();
  const body = usage ? `${BASE.trimEnd()}\n\n${usage.llms.trim()}\n` : BASE;
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
