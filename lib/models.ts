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
    // Ordered by capability; the FIRST entry is the provider default
    // (defaultModelFor), so reordering is a behavior change for every project
    // that never picked a model — don't reorder to freshen the picker.
    models: [
      { id: "claude-opus-4-8", label: "Claude Opus 4.8", note: "Most capable" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5", note: "claude.ai's default" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", note: "Balanced" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", note: "Fast & cheap" },
    ],
  },
  openai: {
    id: "openai",
    label: "OpenAI (ChatGPT)",
    keyUrl: "https://platform.openai.com/api-keys",
    keyPrefix: "sk-",
    // gpt-4o stays first (the default) for measurement continuity — a run's
    // rates are only comparable to the runs before it on the same surface, so
    // moving the default is a deliberate cut-over, not a freshen. The 5.6
    // entries are what ChatGPT actually serves consumers today; nothing is
    // removed because a project pinned to a dropped id would fail its next
    // run at resolveEngine.
    models: [
      { id: "gpt-4o", label: "GPT-4o", note: "Legacy flagship" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", note: "ChatGPT's paid default" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", note: "ChatGPT's free default" },
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
  perplexity: {
    id: "perplexity",
    label: "Perplexity (Sonar)",
    keyUrl: "https://www.perplexity.ai/account/api/keys",
    keyPrefix: "pplx-",
    // Named models rather than dated versions, so these don't rot the way the
    // pinned Gemini ids did. `sonar-deep-research` is deliberately absent: it
    // runs for minutes on a single question, which exceeds the 300s the run
    // route allows for an entire run, so offering it would just be a timeout
    // with a model picker in front of it.
    models: [
      { id: "sonar-pro", label: "Sonar Pro", note: "Most capable" },
      { id: "sonar", label: "Sonar", note: "Fast & cheap" },
      { id: "sonar-reasoning-pro", label: "Sonar Reasoning Pro", note: "Chain-of-thought" },
    ],
  },
  xai: {
    id: "xai",
    label: "xAI (Grok)",
    keyUrl: "https://console.x.ai/team/default/api-keys",
    keyPrefix: "xai-",
    // Two entries, not seven. xAI publishes grok-4.5, three grok-4.20 variants
    // and grok-build-0.1 alongside these, but a new provider has no trend line
    // to preserve, so there is nothing for an older generation to be continuous
    // with — it would just be picker clutter. The 4.20 variants (reasoning,
    // non-reasoning, multi-agent) and grok-build are specialised surfaces no
    // consumer Grok product serves; whether the multi-agent one can finish
    // inside a run's budget is untested, and offering an untested model is how
    // `sonar-deep-research` would have shipped.
    models: [
      { id: "grok-4.6", label: "Grok 4.6", note: "grok.com's default" },
      { id: "grok-4.3", label: "Grok 4.3", note: "Fast & cheap" },
    ],
  },
};

export const PROVIDER_LIST: ProviderInfo[] = Object.values(PROVIDERS);

// Derived from the catalog rather than a hand-written chain of comparisons, so a
// provider added above can't be silently unrecognised here. The chain this
// replaces was compiler-invisible: widening `Provider` did not fail the build,
// it just left the new engine rejected by every write path that validates a
// provider id — a saved key, a project's default, a v1 request body — with no
// error pointing at this function.
//
// hasOwnProperty rather than `value in PROVIDERS`: `in` walks the prototype, so
// "toString" and "constructor" would both answer true and narrow to Provider.
export function isProvider(value: string): value is Provider {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

export function defaultModelFor(provider: Provider): string {
  return PROVIDERS[provider].models[0].id;
}

/** Does this provider actually offer this model? */
export function isModelFor(provider: Provider, modelId: string): boolean {
  return PROVIDERS[provider].models.some((m) => m.id === modelId);
}

export type EngineResolution =
  | { ok: true; provider: Provider; model: string }
  | { ok: false; message: string };

/**
 * Resolve a requested answer engine into a (provider, model) pair that can
 * actually be called, or say why it can't.
 *
 * The two halves have to travel together. The write paths used to apply them
 * independently — a request naming only a provider updated the provider and
 * left the previous model in place — which persisted pairs like
 * `openai` + `claude-opus-4-8`. Nothing rejected that, so it saved cleanly and
 * then failed at the provider on the next run, as an error about a model id the
 * user never chose. A model absent from the request therefore resolves to the
 * provider's default rather than to whatever was there before.
 *
 * The catalog is the authority: an unknown model id is refused rather than
 * stored, since `modelLabel` falls back to echoing the raw id and the UI would
 * happily display "banana" as the selected engine.
 */
export function resolveEngine(provider: Provider, model: unknown): EngineResolution {
  const requested = typeof model === "string" ? model.trim() : "";
  if (!requested) {
    return { ok: true, provider, model: defaultModelFor(provider) };
  }
  if (!isModelFor(provider, requested)) {
    const offered = PROVIDERS[provider].models.map((m) => m.id).join(", ");
    return {
      ok: false,
      message: `${PROVIDERS[provider].label} doesn't offer "${requested}". Available: ${offered}.`,
    };
  }
  return { ok: true, provider, model: requested };
}

const ANALYSIS_MODEL_ENV: Record<Provider, string> = {
  anthropic: "ANALYSIS_ANTHROPIC_MODEL",
  openai: "ANALYSIS_OPENAI_MODEL",
  google: "ANALYSIS_GOOGLE_MODEL",
  perplexity: "ANALYSIS_PERPLEXITY_MODEL",
  xai: "ANALYSIS_XAI_MODEL",
};

const ANALYSIS_MODEL_DEFAULT: Record<Provider, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
  google: "gemini-flash-lite-latest",
  // Sonar is the cheap search model; classification never needs Pro.
  perplexity: "sonar",
  // xAI's own model page calls 4.3 suitable for classification, and it is the
  // cheapest per token of the entries offered above.
  xai: "grok-4.3",
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
