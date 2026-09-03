// Server-only client for Letterstory's published-content API.
//
// The marketing blog at lettertrace.com/blog is a consumer of the same
// `/api/integrations/published` API that the Letterstory phantom fleet builds
// against: posts are authored and published inside app.letterstory.com, and
// this pulls the frozen *published* versions. Nothing is authored in this repo.
//
// Serving /blog from THIS app's origin (rather than a subdomain or a separate
// site) is deliberate: a path on lettertrace.com inherits the domain's existing
// authority, so the blog compounds the traffic the site has already earned.
//
// Freshness is handled two ways (see the fetch below):
//   1. On-demand: app.letterstory.com POSTs /api/revalidate on every publish,
//      which busts the "blog" cache tag (near-instant "rebuild on publish").
//   2. Safety net: an hourly time-based revalidate, in case a webhook is missed.
//
// Env-gated so this is inert on forks / self-hosted deployments: with no key or
// collection set, listPosts()/getPost() return empty and /blog 404s. The key is
// server-only (NOT NEXT_PUBLIC) and must never reach the browser:
//   LETTERBRACE_API_URL   e.g. https://app.letterstory.com   (defaults to prod)
//   LETTERBRACE_API_KEY   an `article:read` integrations key minted in the app
//   BLOG_COLLECTION_ID    the collection that backs lettertrace.com/blog

const API_URL = (process.env.LETTERBRACE_API_URL ?? "https://app.letterstory.com").replace(/\/+$/, "");
const API_KEY = process.env.LETTERBRACE_API_KEY ?? "";
const COLLECTION_ID = process.env.BLOG_COLLECTION_ID ?? "";

const PUBLISHED = `${API_URL}/api/integrations/published`;

/** The cache tag busted by POST /api/revalidate on publish. */
export const BLOG_CACHE_TAG = "blog";

export type PublishedArticle = {
  article_id: string | null;
  slug: string | null;
  collection_id: string | null;
  title: string | null;
  /** Frozen published body, HTML (we always request format=html). */
  content: string | null;
  cover_image: string | null;
  cover_image_alt: string | null;
  summary: string | null;
  author: string | null;
  author_slug: string | null;
  author_profile: {
    bio?: string | null;
    role?: string | null;
    expertise?: string | null;
    writing_since?: string | null;
  } | null;
  published_at: string | null;
  updated_at: string | null;
  tags: string[];
  paper_trail: {
    sources?: Array<{ title?: string | null; url?: string | null }>;
    citation?: unknown;
  } | null;
};

/** True once the API key + collection are wired up (build won't fail before then). */
export function isBlogConfigured(): boolean {
  return Boolean(API_KEY && COLLECTION_ID);
}

async function fetchPublished(query: Record<string, string>): Promise<Response> {
  const url = `${PUBLISHED}?${new URLSearchParams(query).toString()}`;
  return fetch(url, {
    headers: { "x-integrations-key": API_KEY },
    next: { tags: [BLOG_CACHE_TAG], revalidate: 3600 },
  });
}

/**
 * All published posts in the blog's collection, newest first. Returns `[]`
 * (never throws) when unconfigured or on API error, so the page renders an
 * empty state instead of crashing the build.
 */
export async function listPosts(): Promise<PublishedArticle[]> {
  if (!isBlogConfigured()) return [];
  try {
    const res = await fetchPublished({ collection_id: COLLECTION_ID, format: "html" });
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: PublishedArticle[] };
    return (data.items ?? []).filter((p) => p.slug && p.content);
  } catch {
    return [];
  }
}

/**
 * One published post by slug, or `null` if not found / unconfigured. Guarded to
 * the blog's own collection: `get_published` resolves a slug org-wide, so a
 * slug that belongs to a different collection is treated as a miss.
 */
export async function getPost(slug: string): Promise<PublishedArticle | null> {
  if (!isBlogConfigured()) return null;
  try {
    const res = await fetchPublished({ slug, format: "html" });
    if (res.status === 404 || !res.ok) return null;
    const post = (await res.json()) as PublishedArticle;
    if (post.collection_id && post.collection_id !== COLLECTION_ID) return null;
    return post;
  } catch {
    return null;
  }
}
