import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPost, isBlogConfigured, listPosts } from "@/lib/blog";
import BlogPost from "@/components/blog/blog-post";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://lettertrace.com").replace(/\/+$/, "");

type Params = { slug: string };

// Prerender the posts that exist at build time; new posts render on first
// request (dynamicParams defaults to true) and are cached until the "blog" tag
// is revalidated on publish.
export async function generateStaticParams() {
  const posts = await listPosts();
  return posts.map((p) => ({ slug: p.slug as string }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const post = await getPost(params.slug);
  if (!post) return { title: "Not found" };
  const url = `${SITE_URL}/blog/${post.slug}`;
  return {
    title: post.title ?? undefined,
    description: post.summary ?? undefined,
    alternates: { canonical: url },
    openGraph: {
      title: post.title ?? undefined,
      description: post.summary ?? undefined,
      url,
      type: "article",
      publishedTime: post.published_at ?? undefined,
      modifiedTime: post.updated_at ?? undefined,
      images: post.cover_image ? [{ url: post.cover_image }] : undefined,
    },
    twitter: post.cover_image
      ? { card: "summary_large_image", images: [post.cover_image] }
      : undefined,
  };
}

export default async function PostPage({ params }: { params: Params }) {
  if (!isBlogConfigured()) notFound();
  const post = await getPost(params.slug);
  if (!post) notFound();
  return <BlogPost post={post} />;
}
