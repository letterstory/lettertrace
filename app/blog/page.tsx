import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isBlogConfigured, listPosts } from "@/lib/blog";
import BlogIndex from "@/components/blog/blog-index";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://lettertrace.com").replace(/\/+$/, "");

export const metadata: Metadata = {
  title: "Blog",
  description:
    "Writing from the Lettertrace team on AEO, generative-engine optimization, and how AI assistants talk about brands.",
  alternates: { canonical: `${SITE_URL}/blog` },
  openGraph: { title: "Blog · Lettertrace", url: `${SITE_URL}/blog`, type: "website" },
};

export default async function BlogPage() {
  // Inert on forks / self-host: with no CMS key + collection, /blog 404s rather
  // than rendering a permanently empty shell.
  if (!isBlogConfigured()) notFound();
  const posts = await listPosts();
  return <BlogIndex posts={posts} />;
}
