/* eslint-disable @next/next/no-img-element */

// Provider marks for the landing page. OpenAI and Perplexity ship a light and
// a dark asset; the .logo-for-* rules in globals.css show the one matching the
// active theme, so the swap needs no client JS.
const LOGOS = {
  claude: { light: "/providers/anthropic.png" },
  chatgpt: { light: "/providers/openai-black.png", dark: "/providers/openai-white.png" },
  gemini: { light: "/providers/google.png" },
  perplexity: { light: "/providers/perplexity-black.png", dark: "/providers/perplexity-teal.png" },
} as const;

export type Provider = keyof typeof LOGOS;

export function ProviderLogo({ provider, className = "h-4 w-4" }: { provider: Provider; className?: string }) {
  const l = LOGOS[provider] as { light: string; dark?: string };
  if (!l.dark) return <img src={l.light} alt="" aria-hidden className={`${className} object-contain`} />;
  return (
    <>
      <img src={l.light} alt="" aria-hidden className={`logo-for-light ${className} object-contain`} />
      <img src={l.dark} alt="" aria-hidden className={`logo-for-dark ${className} object-contain`} />
    </>
  );
}
