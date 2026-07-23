import type { Provider } from "./types";

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
};

export const PROVIDER_LIST: ProviderInfo[] = Object.values(PROVIDERS);

export function isProvider(value: string): value is Provider {
  return value === "anthropic" || value === "openai";
}

export function defaultModelFor(provider: Provider): string {
  return PROVIDERS[provider].models[0].id;
}

export function modelLabel(provider: Provider, modelId: string): string {
  const found = PROVIDERS[provider]?.models.find((m) => m.id === modelId);
  return found?.label ?? modelId;
}
