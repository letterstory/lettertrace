import type { Provider } from "./types";

// Google AI Overviews is exposed as a distinct answer engine, but it runs on
// the same Google (Gemini) key: it is a pseudo-model under the `google`
// provider that always grounds in Google Search and answers in the terse,
// synthesized style Google shows at the top of a results page. The adapter
// (lib/llm) maps this id onto a real Gemini model for the actual API call.
export const GOOGLE_AI_OVERVIEWS_MODEL = "google-ai-overviews";

export interface ModelOption {
  id: string;
  label: string;
  /** A short note shown in the picker. */
  note?: string;
}

export interface ProviderInfo {
  id: Provider;
  label: string;
  /** Where a user gets a key. */
  keyUrl: string;
  keyPrefix: string;
  models: ModelOption[];
}

// The provider catalog. These are the "answer engines" LetterTrace queries with
// the user's own key. Keeping the list small and current keeps the picker clean.
export const PROVIDERS: Record<Provider, ProviderInfo> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPrefix: "sk-ant-",
    models: [
      { id: "claude-opus-4-8", label: "Claude Opus 4.8", note: "Most capable" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", note: "Balanced" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", note: "Fast & cheap" },
    ],
  },
  openai: {
    id: "openai",
    label: "OpenAI (ChatGPT)",
    keyUrl: "https://platform.openai.com/api-keys",
    keyPrefix: "sk-",
    models: [
      { id: "gpt-4o", label: "GPT-4o", note: "Flagship" },
      { id: "gpt-4o-mini", label: "GPT-4o mini", note: "Fast & cheap" },
      { id: "gpt-4-turbo", label: "GPT-4 Turbo" },
    ],
  },
  google: {
    id: "google",
    label: "Google (Gemini)",
    keyUrl: "https://aistudio.google.com/apikey",
    keyPrefix: "AIza",
    // Google's rolling aliases rather than pinned versions. The pinned 2.5 ids
    // this shipped with were already rejected on a fresh project — "no longer
    // available to new users" — so a pin here rots silently and 404s every run
    // for anyone onboarding after the cut-off. The trade-off is that runs
    // record the alias, so if Google moves what it points at, a change in the
    // trend line may be the model rather than the brand.
    models: [
      { id: "gemini-pro-latest", label: "Gemini Pro", note: "Most capable" },
      { id: "gemini-flash-latest", label: "Gemini Flash", note: "Balanced" },
      { id: "gemini-flash-lite-latest", label: "Gemini Flash-Lite", note: "Fast & cheap" },
      {
        id: GOOGLE_AI_OVERVIEWS_MODEL,
        label: "Google AI Overviews",
        note: "AI Overview-style, grounded in Search",
      },
    ],
  },
};

export const PROVIDER_LIST: ProviderInfo[] = Object.values(PROVIDERS);

export function isProvider(value: string): value is Provider {
  return value === "anthropic" || value === "openai" || value === "google";
}

export function defaultModelFor(provider: Provider): string {
  return PROVIDERS[provider].models[0].id;
}

const ANALYSIS_MODEL_ENV: Record<Provider, string> = {
  anthropic: "ANALYSIS_ANTHROPIC_MODEL",
  openai: "ANALYSIS_OPENAI_MODEL",
  google: "ANALYSIS_GOOGLE_MODEL",
};

const ANALYSIS_MODEL_DEFAULT: Record<Provider, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
  google: "gemini-flash-lite-latest",
};

// Sentiment/recommendation enrichment is a simple structured-JSON judgment;
// running it on the flagship answer model multiplies run cost for no quality
// gain. Always classify on the provider's cheap model (overridable via env).
export function analysisModelFor(provider: Provider): string {
  const override = process.env[ANALYSIS_MODEL_ENV[provider]];
  if (override && override.trim()) return override.trim();
  return ANALYSIS_MODEL_DEFAULT[provider];
}

export function modelLabel(provider: Provider, modelId: string): string {
  const found = PROVIDERS[provider]?.models.find((m) => m.id === modelId);
  return found?.label ?? modelId;
}
