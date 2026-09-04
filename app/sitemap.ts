import type { MetadataRoute } from "next";
import { isBlogConfigured, listPosts } from "@/lib/blog";

// Public sitemap for lettertrace.com — the marketing surface plus every published
// blog post. Search + AI engines fetch this to discover and re-crawl content, so
// it's the backbone of getting /blog indexed.
//
// Only the PUBLIC pages belong here — never the authenticated app (/dashboard,
// /login, /oauth, …) or token-gated routes (/invite/[token]). Blog URLs are added
// only when the CMS blog is wired (isBlogConfigured), so a fork / self-host that
// isn't serving the blog doesn't advertise 404ing /blog URLs.

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://lettertrace.com").replace(/\/+$/, "");

// Refresh hourly so newly published posts appear without a redeploy (matches the
// blog's own ISR tag/time-based revalidate in lib/blog.ts).
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const entries: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];

  if (!isBlogConfigured()) return entries;

  entries.push({ url: `${SITE_URL}/blog`, lastModified: now, changeFrequency: "daily", priority: 0.8 });

  const posts = await listPosts();
  for (const post of posts) {
    if (!post.slug) continue;
    const modified = post.updated_at ?? post.published_at;
    entries.push({
      url: `${SITE_URL}/blog/${post.slug}`,
      lastModified: modified ? new Date(modified) : now,
      changeFrequency: "weekly",
      priority: 0.7,
    });
  }

  return entries;
}
