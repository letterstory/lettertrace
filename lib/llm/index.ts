import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Provider, Sentiment } from "@/lib/types";
import { GOOGLE_AI_OVERVIEWS_MODEL, analysisModelFor } from "@/lib/models";

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
    } else if (provider === "google") {
      await googleChat(apiKey, "gemini-2.5-flash-lite", undefined, "ping", 8);
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
  // Google's answer path handles its own grounding (and forces it for the AI
  // Overviews engine), so route it before the shared web-search branch.
  if (opts.provider === "google") {
    return googleRunQuery(opts.apiKey, opts.model, opts.prompt, opts.webSearch ?? false);
  }
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
  //
  // Keep the 20250305 tool version. The newer web_search_20260209 runs dynamic
  // filtering through code execution and returns results in a shape this parser
  // doesn't read: measured against the same prompt it produced 0 inline
  // citations (vs 11) for 2.6x the tokens, falling back to the "retrieved but
  // not cited" path below. Upgrading needs the citation parsing reworked first.
  const params = {
    model,
    max_tokens: ANSWER_MAX_TOKENS,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCH_MAX_USES }],
    // Force the browse, matching the OpenAI path. Left to choose, the model
    // answers well-known questions from memory and cites nothing — in a live
    // pilot it searched on only 4 of 10 prompts where OpenAI searched on 10,
    // which made the two providers' mention rates measure different things.
    // use_web_search is opt-in per project, so when it's on the user has asked
    // us to check the live web. Costs roughly 4x the tokens of a memory answer.
    tool_choice: { type: "tool", name: "web_search" },
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

// --- Google (Gemini) low-level chat + grounding ---------------------------
// Talks to the Gemini REST API with raw fetch (no SDK), the same way
// openaiWebSearch talks to the Responses API: zero extra dependencies and full
// control over error mapping. One Google key powers both the Gemini models and
// the "Google AI Overviews" pseudo-model.

const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE_TIMEOUT_MS = 60_000;
const GOOGLE_MAX_ATTEMPTS = 4;
// HTTP statuses worth retrying (transient); everything else fails fast.
const GOOGLE_RETRYABLE = new Set([429, 500, 503, 504]);
// The real Gemini model the "Google AI Overviews" engine runs on. AI Overviews
// are served by a fast Gemini model over Google Search, so we back them with
// Flash and always ground the answer in Search.
const AI_OVERVIEWS_BACKING_MODEL = "gemini-2.5-flash";
// Gemini 2.5 "thinking" tokens are billed as output and drawn from the same
// budget as the visible answer, so a small maxOutputTokens can be spent on
// thoughts, leaving an empty answer (finishReason MAX_TOKENS). On the flash
// models we turn thinking off; on models that can't disable it (e.g. pro) we
// give the output budget generous headroom instead.
const GOOGLE_THINKING_HEADROOM = 4096;

// A Gemini HTTP error carrying the status + google.rpc status name so
// humanError can map it (an invalid key is 400 with an "API key not valid"
// message, a rate limit is 429 RESOURCE_EXHAUSTED, etc.).
export class GoogleAPIError extends Error {
  status: number;
  googleStatus?: string;
  constructor(status: number, message: string, googleStatus?: string) {
    super(message);
    this.name = "GoogleAPIError";
    this.status = status;
    this.googleStatus = googleStatus;
  }
}

interface GoogleGroundingChunk {
  web?: { uri?: string; title?: string };
}

interface GoogleResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
    groundingMetadata?: { groundingChunks?: GoogleGroundingChunk[] };
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { code?: number; message?: string; status?: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Map the "google-ai-overviews" pseudo-model onto a real Gemini model so it
// never reaches the wire; every other id passes through untouched.
function resolveGoogleModel(model: string): string {
  return model === GOOGLE_AI_OVERVIEWS_MODEL ? AI_OVERVIEWS_BACKING_MODEL : model;
}

// Flash / Flash-Lite (2.5) can fully disable thinking with thinkingBudget: 0;
// pro and the 3.x line can't, so detect the flash family by id.
function googleThinkingOff(realModel: string): boolean {
  return /^gemini-2\.5-flash/.test(realModel);
}

async function googleFetch(realModel: string, apiKey: string, body: unknown): Promise<GoogleResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < GOOGLE_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${GOOGLE_API_BASE}/models/${realModel}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      });
      if (res.ok) return (await res.json()) as GoogleResponse;
      const errBody = (await res.json().catch(() => ({}))) as GoogleResponse;
      const gerr = new GoogleAPIError(
        res.status,
        errBody.error?.message ?? `Google API error (${res.status}).`,
        errBody.error?.status,
      );
      // Retry transient statuses; surface auth/quota/bad-request immediately.
      if (!GOOGLE_RETRYABLE.has(res.status)) throw gerr;
      lastErr = gerr;
    } catch (err) {
      // Non-retryable HTTP errors bubble straight out; network/timeout drops
      // and retryable HTTP errors fall through to a backoff + retry.
      if (err instanceof GoogleAPIError && !GOOGLE_RETRYABLE.has(err.status)) throw err;
      lastErr = err;
    }
    if (attempt < GOOGLE_MAX_ATTEMPTS - 1) await sleep(400 * 2 ** attempt);
  }
  throw lastErr ?? new Error("Google request failed.");
}

interface GoogleGenOpts {
  system?: string;
  json?: boolean;
  grounding?: boolean;
  maxTokens: number;
}

async function googleGenerate(
  apiKey: string,
  model: string,
  user: string,
  opts: GoogleGenOpts,
): Promise<{ text: string; tokens: number; groundingChunks: GoogleGroundingChunk[] }> {
  const realModel = resolveGoogleModel(model);
  const thinkingOff = googleThinkingOff(realModel);
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: thinkingOff
      ? opts.maxTokens
      : Math.max(opts.maxTokens, GOOGLE_THINKING_HEADROOM),
  };
  // JSON response mode and Google Search grounding can't be combined on Gemini
  // 2.5, but we never ask for both at once: utility calls are JSON without
  // search, monitored answers are grounded free-text.
  if (opts.json) generationConfig.responseMimeType = "application/json";
  if (thinkingOff) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig,
  };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
  if (opts.grounding) body.tools = [{ google_search: {} }];

  const data = await googleFetch(realModel, apiKey, body);
  const cand = data.candidates?.[0];
  // parts may include a separate "thought" summary part; keep only answer text.
  const text = (cand?.content?.parts ?? [])
    .filter((p) => typeof p.text === "string" && p.thought !== true)
    .map((p) => p.text as string)
    .join("")
    .trim();
  const tokens =
    data.usageMetadata?.totalTokenCount ??
    (data.usageMetadata?.promptTokenCount ?? 0) + (data.usageMetadata?.candidatesTokenCount ?? 0);
  return { text, tokens, groundingChunks: cand?.groundingMetadata?.groundingChunks ?? [] };
}

// Chat helper matching anthropicChat / openaiChat so the utility calls branch
// on provider uniformly.
async function googleChat(
  apiKey: string,
  model: string,
  system: string | undefined,
  user: string,
  maxTokens: number,
  json = false,
): Promise<ChatResult> {
  const { text, tokens } = await googleGenerate(apiKey, model, user, { system, json, maxTokens });
  return { text, tokens };
}

// A Gemini grounding chunk's web.title is the source DOMAIN (e.g. "uefa.com"),
// while web.uri is a Google redirect link (vertexaisearch.cloud.google.com/...)
// that resolves to the real page. Keep the redirect as the clickable url but
// take the domain from the title so ownership / attribution works. (Those
// redirect links expire after ~30 days; resolving them to the final URL for
// durable citations is a possible future enhancement.)
export function domainFromTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const t = title.trim().toLowerCase().replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(t) ? t : null;
}

// Google serves grounding links through its own redirect host, so the URI never
// carries the real domain. The title usually does.
const GOOGLE_REDIRECT_HOST = "vertexaisearch.cloud.google.com";

export function googleGroundingSources(chunks: GoogleGroundingChunk[]): CitedSource[] {
  const raw: CitedSource[] = [];
  for (const c of chunks) {
    const uri = c.web?.uri;
    if (!uri) continue;
    const validated = safeSource(uri, c.web?.title ?? null, null);
    if (!validated) continue;
    const domain = domainFromTitle(c.web?.title);

    // A redirect URI whose title isn't a hostname leaves nothing to attribute
    // the citation to. Falling back to validated.domain would record Google's
    // own redirect host: it can never match a brand's domain, so is_owned would
    // silently under-report, and it would crowd the cited-domain leaderboard
    // with a host nobody published to. Drop the chunk instead — sources.domain
    // is NOT NULL, and a wrong domain is worse than a missing row.
    if (!domain && validated.domain === GOOGLE_REDIRECT_HOST) continue;

    raw.push({ ...validated, domain: domain ?? validated.domain });
  }
  return dedupeSources(raw);
}

const AI_OVERVIEW_SYSTEM = `You are Google's AI Overview, the AI-generated summary shown at the top of a Google Search results page. Given the user's search query, write the overview Google would surface.
- Answer directly and immediately. No preamble, no "as an AI", no restating the question.
- Synthesize current information from the web. Name the specific brands, products, tools, companies, or sources that are genuinely relevant to the query.
- Keep it tight: a short paragraph or two, or a brief bulleted list, the way an AI Overview reads.
- Neutral, informational tone.`;

// Google's runQuery path: the AI-Overviews engine always grounds in Search with
// the overview-style system prompt; a plain Gemini model grounds only when web
// search is on.
async function googleRunQuery(
  apiKey: string,
  model: string,
  prompt: string,
  webSearch: boolean,
): Promise<QueryResult> {
  const isOverview = model === GOOGLE_AI_OVERVIEWS_MODEL;
  const grounding = isOverview || webSearch;
  const { text, tokens, groundingChunks } = await googleGenerate(apiKey, model, prompt, {
    system: isOverview ? AI_OVERVIEW_SYSTEM : undefined,
    grounding,
    maxTokens: ANSWER_MAX_TOKENS,
  });
  return { text, tokens, sources: grounding ? googleGroundingSources(groundingChunks) : [] };
}

// Prompt shape is the single biggest lever on whether a run measures anything.
// Measured against a stealth-stage brand (24 queries per shape, both providers):
//
//   "List the top 5 companies that…" / "Name the vendors…"   3.7 vendors named
//   "Who are the main players in X?"                          2.5 vendors named
//   "Give me a shortlist with names"                          0.8 vendors named
//   how-to / "best X for Y" / "which vendors offer X"         ~0  vendors named
//
// The brand appeared in 50% of the first group and 0% of everything else. The
// failure mode is subtle: how-to and best-X questions read like exactly what a
// buyer would type, and get answered with an explanation of the category rather
// than a list of companies — so the run is real, the answer is good, and the
// measurement is empty. Asking for "a shortlist" is the trap: it sounds like a
// request for names and reliably returns advice on how to choose instead.
const VARIATION_SYSTEM = `You generate the questions a brand-monitoring tool will ask an AI assistant (ChatGPT, Claude) to discover which companies get named in answers about a topic.

A question is only useful if the answer to it names specific companies. Questions that read naturally but get answered with explanation instead of names measure nothing. That is the most common failure and the one to avoid.

Rules:
- At least two thirds of the questions must explicitly demand named companies. Shapes that work: "List the top 5 companies that…", "Name the specific vendors that…", "Rank the leading providers of… by name", "Which companies sell…? Just the company names." Use the words "companies", "vendors", or "providers", and ask for them by name.
- Never ask for "a shortlist" or for how to choose/evaluate. Both get answered with advice about making a decision rather than with the options themselves.
- Keep the remaining questions in a buyer's own words ("What's the best X for Y?", "Who are the main players in X?") so the set reflects real usage, but keep them the minority.
- Do NOT name any specific brand in the questions unless the brand is part of the topic itself.
- Vary buyer intent and seniority, not just the wording.
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
      : opts.provider === "google"
        ? await googleChat(
            opts.apiKey,
            opts.model,
            VARIATION_SYSTEM + "\nReturn a JSON array of strings.",
            user,
            UTILITY_MAX_TOKENS,
            true,
          )
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
 * Map a model's raw analysis rows back onto the entities we asked about.
 *
 * Models are unreliable about which identifier they echo: Claude returns the
 * `key` we supplied, while gpt-4o-mini routinely returns the entity's *name*
 * instead ("Cloudflare" rather than "brand"). Keying purely off `key` silently
 * dropped every OpenAI row, so the caller fell back to neutral / not-recommended
 * for the whole project. Resolve on key first, then name, and drop anything that
 * matches neither rather than inventing a verdict.
 *
 * Exported for tests; `analyzeResponse` is the real entry point.
 */
export function parseAnalysis(entities: AnalyzeEntity[], raw: unknown): AnalyzedResult[] {
  let parsed = raw;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    parsed = (parsed as { results?: unknown }).results ?? [];
  }
  const rows = Array.isArray(parsed) ? parsed : [];

  // Both lookups point at the canonical key. Keys win: an entity whose *name*
  // collides with another entity's key must not steal its row.
  const byName = new Map<string, string>();
  const byKey = new Map<string, string>();
  for (const e of entities) {
    byKey.set(e.key.trim().toLowerCase(), e.key);
    const name = e.name.trim().toLowerCase();
    if (name && !byName.has(name)) byName.set(name, e.key);
  }

  const results: AnalyzedResult[] = [];
  const seen = new Set<string>();
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;

    const candidates = [o.key, o.name, o.entity]
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim().toLowerCase());
    let key: string | undefined;
    for (const c of candidates) {
      key = byKey.get(c) ?? byName.get(c);
      if (key) break;
    }
    // A row we can't attribute is worse than no row: it would be applied to the
    // wrong entity. Drop it and let the caller default.
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const sentiment: Sentiment =
      o.sentiment === "positive" || o.sentiment === "negative" ? o.sentiment : "neutral";
    results.push({ key, sentiment, recommended: Boolean(o.recommended) });
  }
  return results;
}

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
        : opts.provider === "google"
          ? await googleChat(opts.apiKey, analysisModel, ANALYZE_SYSTEM, user, 700, true)
          : await openaiChat(opts.apiKey, analysisModel, ANALYZE_SYSTEM, user, 700, true);

    return { results: parseAnalysis(opts.entities, extractJson(res.text)), tokens: res.tokens };
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
      : opts.provider === "google"
        ? await googleChat(opts.apiKey, opts.model, SUGGEST_SYSTEM, user, 2000, true)
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
      : opts.provider === "google"
        ? await googleChat(opts.apiKey, opts.model, COMPETITOR_SYSTEM, user, UTILITY_MAX_TOKENS, true)
        : await openaiChat(opts.apiKey, opts.model, COMPETITOR_SYSTEM, user, UTILITY_MAX_TOKENS, true);

  try {
    let parsed: unknown = extractJson(res.text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parsed = (parsed as { competitors?: unknown }).competitors ?? [];
    }
    const arr = Array.isArray(parsed) ? parsed : [];
    const suggestions: CompetitorSuggestion[] = [];
    // Models occasionally list the same company twice in one response. Two rows
    // for one competitor become two entities in computeEntityStats, which
    // inflates the share-of-voice denominator and understates the brand.
    const seen = new Set<string>();
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name.trim() : "";
      if (!name) continue;
      const dedupeKey = name.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
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
  if (err instanceof GoogleAPIError) {
    // Google returns a bad key as 400 INVALID_ARGUMENT with an "API key not
    // valid" message (not 401), so match on the message as well as the status.
    if (err.status === 429) return "Rate limited by the provider.";
    if (err.status >= 500) return "The AI provider had a temporary error. Please try again.";
    if (err.status === 401 || /api[_ ]?key.*(not valid|invalid)|api_key_invalid/i.test(err.message)) {
      return "Invalid API key.";
    }
    if (err.status === 403) return "This key lacks access to the requested model.";
    if (err.status === 404) return "The requested model isn't available for this key.";
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
