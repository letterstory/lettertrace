import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Provider, Sentiment } from "@/lib/types";
import { analysisModelFor } from "@/lib/models";

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

// Provider APIs occasionally drop a keep-alive connection mid-response
// ("Premature close" / "socket hang up"), especially under Node's fetch. Both
// SDKs retry such transient connection errors with backoff; we raise the count
// above the default (2) and set an explicit ceiling so a call can't hang.
const CLIENT_OPTS = { maxRetries: 4, timeout: 60_000 } as const;

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

// A web source the model cited while answering (native provider web search).
export interface CitedSource {
  url: string;
  domain: string;
  title: string | null;
  snippet: string | null;
}

export interface QueryResult extends ChatResult {
  sources: CitedSource[];
}

// How many web searches a single monitored query may run.
const WEB_SEARCH_MAX_USES = 5;

// Parse a citation URL, keeping only safe http(s) links (guards against a
// model citing a javascript:/data: URL that would later render as an href).
// Returns the cleaned url + its registrable host, or null to drop the source.
export function safeSource(url: string, title: string | null, snippet: string | null): CitedSource | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return {
    url,
    domain: parsed.hostname.replace(/^www\./i, "").toLowerCase(),
    title,
    snippet,
  };
}

// Collapse cited sources to one row per URL, keeping the first title/snippet.
export function dedupeSources(raw: CitedSource[]): CitedSource[] {
  const seen = new Map<string, CitedSource>();
  for (const s of raw) {
    if (!s.url) continue;
    const existing = seen.get(s.url);
    if (!existing) seen.set(s.url, s);
    else if (!existing.snippet && s.snippet) existing.snippet = s.snippet;
  }
  return Array.from(seen.values());
}

// --- Low-level chat helpers -----------------------------------------------

async function anthropicChat(
  apiKey: string,
  model: string,
  system: string | undefined,
  user: string,
  maxTokens: number,
): Promise<ChatResult> {
  const client = new Anthropic({ apiKey, ...CLIENT_OPTS });
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
  const client = new OpenAI({ apiKey, ...CLIENT_OPTS });
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

/**
 * Ask the model a monitored question and return its natural answer, token
 * usage, and (when `webSearch` is on) the web sources it cited. Web search uses
 * each provider's NATIVE browsing via the user's own key — no third-party
 * search service — so it stays fully self-hostable.
 */
export async function runQuery(
  opts: BaseCall & { prompt: string; webSearch?: boolean },
): Promise<QueryResult> {
  if (!opts.webSearch) {
    const res =
      opts.provider === "anthropic"
        ? await anthropicChat(opts.apiKey, opts.model, undefined, opts.prompt, ANSWER_MAX_TOKENS)
        : await openaiChat(opts.apiKey, opts.model, undefined, opts.prompt, ANSWER_MAX_TOKENS);
    return { ...res, sources: [] };
  }
  return opts.provider === "anthropic"
    ? anthropicWebSearch(opts.apiKey, opts.model, opts.prompt)
    : openaiWebSearch(opts.apiKey, opts.model, opts.prompt);
}

// --- Native web-search query paths ---------------------------------------

async function anthropicWebSearch(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<QueryResult> {
  const client = new Anthropic({ apiKey, ...CLIENT_OPTS });
  // web_search is a server-side tool not in older SDK typings; cast the params.
  const params = {
    model,
    max_tokens: ANSWER_MAX_TOKENS,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCH_MAX_USES }],
    messages: [{ role: "user", content: prompt }],
  };
  const msg = await client.messages.create(
    params as unknown as Anthropic.MessageCreateParamsNonStreaming,
  );

  // The web_search block/citation shapes aren't in older SDK types; read them
  // structurally.
  type Cite = { url?: string; title?: string; cited_text?: string };
  type Block = {
    type?: string;
    text?: string;
    citations?: Cite[];
    content?: { url?: string; title?: string }[];
  };
  let text = "";
  const cited: CitedSource[] = [];
  const retrieved: CitedSource[] = [];
  const blocks = (msg.content ?? []) as unknown as Block[];
  for (const block of blocks) {
    if (block.type === "text") {
      text += (text ? "\n" : "") + (block.text ?? "");
      // Sources the answer actually cited — the primary signal.
      for (const c of block.citations ?? []) {
        const s = c.url ? safeSource(c.url, c.title ?? null, c.cited_text ?? null) : null;
        if (s) cited.push(s);
      }
    } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      // Retrieved but maybe not cited — used only as a fallback below.
      for (const r of block.content) {
        const s = r.url ? safeSource(r.url, r.title ?? null, null) : null;
        if (s) retrieved.push(s);
      }
    }
  }

  // Prefer inline citations (what the answer used); fall back to retrieved
  // results only when the model searched but cited nothing inline.
  const sources = dedupeSources(cited.length > 0 ? cited : retrieved);
  const tokens = (msg.usage?.input_tokens ?? 0) + (msg.usage?.output_tokens ?? 0);
  return { text: text.trim(), tokens, sources };
}

// OpenAI native web search via the Responses API. Uses raw fetch so it doesn't
// depend on a newer SDK; retries a couple of transient failures. The browse is
// forced via tool_choice (see below) — verified live for gpt-4o / gpt-4o-mini.
async function openaiWebSearch(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<QueryResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          tools: [{ type: "web_search_preview" }],
          // Force the browse; left to choose, the model often answers from
          // memory and cites nothing.
          tool_choice: { type: "web_search_preview" },
          input: prompt,
          max_output_tokens: ANSWER_MAX_TOKENS,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new OpenAI.APIError(res.status, body, undefined, undefined);
        // Retry transient server errors; surface auth/quota immediately.
        if (res.status >= 500) { lastErr = err; continue; }
        throw err;
      }
      const j = (await res.json()) as {
        output?: { content?: { type?: string; text?: string; annotations?: { url?: string; title?: string }[] }[] }[];
        usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number };
      };
      let text = "";
      const raw: CitedSource[] = [];
      for (const item of j.output ?? []) {
        for (const c of item.content ?? []) {
          if (typeof c.text === "string") text += (text ? "\n" : "") + c.text;
          for (const a of c.annotations ?? []) {
            const s = a?.url ? safeSource(a.url, a.title ?? null, null) : null;
            if (s) raw.push(s);
          }
        }
      }
      const tokens =
        j.usage?.total_tokens ??
        (j.usage?.input_tokens ?? 0) + (j.usage?.output_tokens ?? 0);
      return { text: text.trim(), tokens, sources: dedupeSources(raw) };
    } catch (err) {
      lastErr = err;
      if (err instanceof OpenAI.APIError && err.status && err.status < 500) throw err;
    }
  }
  throw lastErr ?? new Error("OpenAI web search failed.");
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

  // Classification always runs on the cheap model, regardless of which model
  // answered the question — see analysisModelFor.
  const analysisModel = analysisModelFor(opts.provider);

  try {
    const res =
      opts.provider === "anthropic"
        ? await anthropicChat(opts.apiKey, analysisModel, ANALYZE_SYSTEM, user, 700)
        : await openaiChat(opts.apiKey, analysisModel, ANALYZE_SYSTEM, user, 700, true);

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
  // Transient connection drops (surface as APIConnectionError with no status)
  // are worth a distinct, retry-friendly message rather than a raw SDK string.
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError) {
    return "Couldn't reach the AI provider (connection dropped). Please try again.";
  }
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) {
    if (err.status === 401) return "Invalid API key.";
    if (err.status === 429) return "Rate limited by the provider.";
    if (err.status === 403) return "This key lacks access to the requested model.";
    if (err.status && err.status >= 500) return "The AI provider had a temporary error. Please try again.";
    return err.message || `Provider error (${err.status}).`;
  }
  if (err instanceof Error) {
    if (/premature close|socket hang up|ECONNRESET|terminated|fetch failed/i.test(err.message)) {
      return "Couldn't reach the AI provider (connection dropped). Please try again.";
    }
    return err.message;
  }
  return "Unknown error.";
}
