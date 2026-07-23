import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Provider, Sentiment } from "@/lib/types";

// ------------------------------------------------------------------
// Provider adapters. Every call here uses the *user's own* API key (BYOK).
// Two shapes of call:
//   1. runQuery: ask the model a question like a real user would, and
//      capture the natural assistant answer (the thing we scan for mentions).
//   2. utility calls: generateVariations / analyzeResponse, structured JSON
//      tasks Lettertrace runs on the user's behalf.
// ------------------------------------------------------------------

const ANSWER_MAX_TOKENS = 1200;
const UTILITY_MAX_TOKENS = 1500;

interface BaseCall {
  provider: Provider;
  model: string;
  apiKey: string;
}

// Every low-level call reports its total token usage so the trial layer can
// meter it. `tokens` is input + output tokens for the call.
export interface ChatResult {
  text: string;
  tokens: number;
}

// --- Low-level chat helpers -----------------------------------------------

async function anthropicChat(
  apiKey: string,
  model: string,
  system: string | undefined,
  user: string,
  maxTokens: number,
): Promise<ChatResult> {
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: "user", content: user }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const tokens = (msg.usage?.input_tokens ?? 0) + (msg.usage?.output_tokens ?? 0);
  return { text, tokens };
}

async function openaiChat(
  apiKey: string,
  model: string,
  system: string | undefined,
  user: string,
  maxTokens: number,
  json = false,
): Promise<ChatResult> {
  const client = new OpenAI({ apiKey });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });
  const res = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages,
    ...(json ? { response_format: { type: "json_object" } } : {}),
  });
  return {
    text: (res.choices[0]?.message?.content ?? "").trim(),
    tokens: res.usage?.total_tokens ?? 0,
  };
}

// Pull the first JSON value out of a model reply (handles ```json fences etc.).
function extractJson<T>(raw: string): T {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const firstBrace = text.search(/[[{]/);
  if (firstBrace > 0) text = text.slice(firstBrace);
  const lastBrace = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
  if (lastBrace >= 0) text = text.slice(0, lastBrace + 1);
  return JSON.parse(text) as T;
}

// --- Public API -----------------------------------------------------------

/** Verify a BYOK key with a tiny probe call. */
export async function verifyKey(
  provider: Provider,
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (provider === "anthropic") {
      await anthropicChat(apiKey, "claude-haiku-4-5", undefined, "ping", 4);
    } else {
      await openaiChat(apiKey, "gpt-4o-mini", undefined, "ping", 4);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: humanError(err) };
  }
}

/** Ask the model a monitored question and return its natural answer + token usage. */
export async function runQuery(opts: BaseCall & { prompt: string }): Promise<ChatResult> {
  if (opts.provider === "anthropic") {
    return anthropicChat(opts.apiKey, opts.model, undefined, opts.prompt, ANSWER_MAX_TOKENS);
  }
  return openaiChat(opts.apiKey, opts.model, undefined, opts.prompt, ANSWER_MAX_TOKENS);
}

const VARIATION_SYSTEM = `You generate realistic search-style questions that a real person would type into an AI assistant (like ChatGPT or Claude) when researching a topic. The questions should be the kind of prompt where an AI assistant might naturally recommend, compare, or mention specific brands, products, or tools.

Rules:
- Write natural, varied phrasings (comparisons, "best X for Y", how-to, recommendations, alternatives).
- Do NOT mention any specific brand name in the questions unless it is part of the topic itself.
- Cover different buyer intents and personas.
- Return ONLY a JSON array of strings. No commentary.`;

/** Generate natural prompt variations for a topic. */
export async function generateVariations(
  opts: BaseCall & {
    topicName: string;
    topicDescription?: string | null;
    count: number;
  },
): Promise<{ variations: string[]; tokens: number }> {
  const user = `Topic: ${opts.topicName}${
    opts.topicDescription ? `\nContext: ${opts.topicDescription}` : ""
  }

Generate ${opts.count} distinct questions a person might ask an AI assistant related to this topic. Return a JSON array of ${opts.count} strings.`;

  const res =
    opts.provider === "anthropic"
      ? await anthropicChat(opts.apiKey, opts.model, VARIATION_SYSTEM, user, UTILITY_MAX_TOKENS)
      : await openaiChat(
          opts.apiKey,
          opts.model,
          VARIATION_SYSTEM + "\nReturn a JSON object shaped { \"questions\": string[] }.",
          user,
          UTILITY_MAX_TOKENS,
          true,
        );

  let parsed: unknown = extractJson(res.text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    parsed = (parsed as { questions?: unknown }).questions ?? [];
  }
  const arr = Array.isArray(parsed) ? parsed : [];
  const variations = arr
    .map((q) => (typeof q === "string" ? q.trim() : ""))
    .filter((q) => q.length > 0)
    .slice(0, opts.count);
  return { variations, tokens: res.tokens };
}

export interface AnalyzeEntity {
  key: string; // 'brand' or a competitor id
  name: string;
}

export interface AnalyzedResult {
  key: string;
  sentiment: Sentiment;
  recommended: boolean;
}

const ANALYZE_SYSTEM = `You analyze how brands are portrayed inside an AI assistant's answer. For each entity you are given, decide:
- sentiment: how the answer talks about it, "positive", "neutral", or "negative".
- recommended: true if the answer actively recommends / suggests / endorses it, otherwise false.
Only judge based on the provided answer text. Return ONLY JSON.`;

/**
 * Given an assistant answer and the entities that were detected in it, classify
 * sentiment + whether each was recommended. Only pass entities already known to
 * be mentioned (saves tokens; an entity not in the text has no sentiment).
 */
export async function analyzeResponse(
  opts: BaseCall & {
    question: string;
    responseText: string;
    entities: AnalyzeEntity[];
  },
): Promise<{ results: AnalyzedResult[]; tokens: number }> {
  if (opts.entities.length === 0) return { results: [], tokens: 0 };

  const entityList = opts.entities
    .map((e) => `- key="${e.key}" name="${e.name}"`)
    .join("\n");

  const user = `QUESTION ASKED:
${opts.question}

AI ASSISTANT ANSWER:
"""
${opts.responseText.slice(0, 6000)}
"""

ENTITIES TO JUDGE:
${entityList}

Return a JSON object: { "results": [ { "key": "<key>", "sentiment": "positive|neutral|negative", "recommended": true|false } ] } with one entry per entity.`;

  try {
    const res =
      opts.provider === "anthropic"
        ? await anthropicChat(opts.apiKey, opts.model, ANALYZE_SYSTEM, user, 700)
        : await openaiChat(opts.apiKey, opts.model, ANALYZE_SYSTEM, user, 700, true);

    let parsed: unknown = extractJson(res.text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parsed = (parsed as { results?: unknown }).results ?? [];
    }
    const arr = Array.isArray(parsed) ? parsed : [];
    const valid: AnalyzedResult[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const key = typeof o.key === "string" ? o.key : null;
      const sentiment = o.sentiment;
      if (!key) continue;
      const s: Sentiment =
        sentiment === "positive" || sentiment === "negative" ? sentiment : "neutral";
      valid.push({ key, sentiment: s, recommended: Boolean(o.recommended) });
    }
    return { results: valid, tokens: res.tokens };
  } catch {
    // Sentiment is best-effort enrichment; never fail a run over it.
    return {
      results: opts.entities.map((e) => ({ key: e.key, sentiment: "neutral" as const, recommended: false })),
      tokens: 0,
    };
  }
}

const SUGGEST_SYSTEM = `You help set up brand-monitoring. Given a company name and text scraped from its website, infer what the company does, then propose monitoring topics. For each topic, write realistic questions a real person would type into an AI assistant (ChatGPT or Claude) where a company like this could be recommended, compared, or mentioned. Do NOT mention the company's own name in the questions. Return ONLY JSON.`;

export interface SiteSuggestion {
  description: string;
  topics: { name: string; prompts: string[] }[];
}

/** From scraped site text, infer what the company does and suggest topics + prompts. */
export async function suggestFromSite(
  opts: BaseCall & { brandName: string; siteText: string },
): Promise<SiteSuggestion & { tokens: number }> {
  const user = `Company: ${opts.brandName}

Website text:
"""
${opts.siteText.slice(0, 6000)}
"""

Return a JSON object of this shape:
{
  "description": "one concise sentence describing what the company does",
  "topics": [
    { "name": "short topic label", "prompts": ["question 1", "question 2", "question 3", "question 4"] }
  ]
}
Provide 3 or 4 topics, each with 4 to 6 natural questions. Never put the company's own name in the questions.`;

  const res =
    opts.provider === "anthropic"
      ? await anthropicChat(opts.apiKey, opts.model, SUGGEST_SYSTEM, user, 2000)
      : await openaiChat(opts.apiKey, opts.model, SUGGEST_SYSTEM, user, 2000, true);

  try {
    const parsed = extractJson<Record<string, unknown>>(res.text);
    const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
    const rawTopics = Array.isArray(parsed.topics) ? parsed.topics : [];
    const topics = rawTopics
      .map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        const name = typeof o.name === "string" ? o.name.trim() : "";
        const prompts = Array.isArray(o.prompts)
          ? o.prompts
              .map((p) => (typeof p === "string" ? p.trim() : ""))
              .filter((p) => p.length > 0)
          : [];
        return { name, prompts };
      })
      .filter((t) => t.name.length > 0 && t.prompts.length > 0)
      .slice(0, 5);
    return { description, topics, tokens: res.tokens };
  } catch {
    return { description: "", topics: [], tokens: res.tokens };
  }
}

const COMPETITOR_SYSTEM = `You identify direct competitors of a company for brand monitoring. You act as a strict judge: only name real companies/products you are confident exist and genuinely compete for the same buyers in the same category. Prefer well-known, currently active competitors over obscure or defunct ones.

Rules:
- Never include the company itself or anything on the already-tracked list.
- "aliases": other names an AI assistant's answer might use for it (short name, product name, former name). Empty array if none.
- "domain": its primary website domain, lowercase, no protocol/path. null if unsure.
- "reason": one short sentence on why it is a direct competitor.
- Fewer, correct suggestions beat a padded list. Return ONLY JSON.`;

export interface CompetitorSuggestion {
  name: string;
  domain: string | null;
  aliases: string[];
  reason: string;
}

/**
 * Suggest direct competitors for the monitored brand. Today the model proposes
 * candidates from its own knowledge; when `candidates` is provided (e.g. from a
 * search provider like Exa / you.com, planned) the model instead judges that
 * list and keeps only genuine direct competitors.
 */
export async function suggestCompetitors(
  opts: BaseCall & {
    brandName: string;
    brandDomain?: string | null;
    description?: string | null;
    topics: string[];
    existing: string[];
    count: number;
    candidates?: string[];
  },
): Promise<{ suggestions: CompetitorSuggestion[]; tokens: number }> {
  const lines = [
    `Company: ${opts.brandName}${opts.brandDomain ? ` (${opts.brandDomain})` : ""}`,
  ];
  if (opts.description) lines.push(`What it does: ${opts.description}`);
  if (opts.topics.length) lines.push(`Topics being monitored: ${opts.topics.join("; ")}`);
  if (opts.existing.length) lines.push(`Already tracked (exclude these): ${opts.existing.join("; ")}`);
  if (opts.candidates?.length) {
    lines.push(
      `Candidate companies found by search. Judge ONLY these; keep the genuine direct competitors and drop the rest:\n${opts.candidates
        .map((c) => `- ${c}`)
        .join("\n")}`,
    );
  } else {
    lines.push(`Propose up to ${opts.count} direct competitors.`);
  }
  lines.push(
    `Return a JSON object: { "competitors": [ { "name": string, "domain": string|null, "aliases": string[], "reason": string } ] }`,
  );
  const user = lines.join("\n\n");

  const res =
    opts.provider === "anthropic"
      ? await anthropicChat(opts.apiKey, opts.model, COMPETITOR_SYSTEM, user, UTILITY_MAX_TOKENS)
      : await openaiChat(opts.apiKey, opts.model, COMPETITOR_SYSTEM, user, UTILITY_MAX_TOKENS, true);

  try {
    let parsed: unknown = extractJson(res.text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parsed = (parsed as { competitors?: unknown }).competitors ?? [];
    }
    const arr = Array.isArray(parsed) ? parsed : [];
    const suggestions: CompetitorSuggestion[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name.trim() : "";
      if (!name) continue;
      suggestions.push({
        name,
        domain:
          typeof o.domain === "string" && o.domain.trim().length > 0
            ? o.domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]
            : null,
        aliases: Array.isArray(o.aliases)
          ? o.aliases
              .map((a) => (typeof a === "string" ? a.trim() : ""))
              .filter((a) => a.length > 0)
          : [],
        reason: typeof o.reason === "string" ? o.reason.trim() : "",
      });
    }
    return { suggestions: suggestions.slice(0, opts.count), tokens: res.tokens };
  } catch {
    return { suggestions: [], tokens: res.tokens };
  }
}

export function humanError(err: unknown): string {
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) {
    if (err.status === 401) return "Invalid API key.";
    if (err.status === 429) return "Rate limited by the provider.";
    if (err.status === 403) return "This key lacks access to the requested model.";
    return err.message || `Provider error (${err.status}).`;
  }
  if (err instanceof Error) return err.message;
  return "Unknown error.";
}
