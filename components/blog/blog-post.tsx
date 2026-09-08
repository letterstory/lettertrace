import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { PublishedArticle } from "@/lib/blog";
import { formatPostDate } from "@/components/blog/format";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://lettertrace.com").replace(/\/+$/, "");

// A single blog post. The body is the frozen published HTML from the CMS,
// rendered with prose styling scoped via Tailwind arbitrary variants (the same
// approach as components/legal.tsx). Includes BlogPosting JSON-LD so search and
// AI engines get structured authorship/date signals — the point of serving this
// on the authoritative apex.
export default function BlogPost({ post }: { post: PublishedArticle }) {
  const date = formatPostDate(post.published_at);
  const url = `${SITE_URL}/blog/${post.slug}`;
  const sources = (post.paper_trail?.sources ?? []).filter((s) => s.url);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title ?? undefined,
    description: post.summary ?? undefined,
    image: post.cover_image ?? undefined,
    datePublished: post.published_at ?? undefined,
    dateModified: post.updated_at ?? post.published_at ?? undefined,
    author: post.author ? { "@type": "Person", name: post.author } : undefined,
    publisher: {
      "@type": "Organization",
      name: "Lettertrace",
      logo: { "@type": "ImageObject", url: `${SITE_URL}/icon.png` },
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    url,
  };

  return (
    <article className="mx-auto max-w-3xl px-5 py-14">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <Link
        href="/blog"
        className="inline-flex items-center gap-1 text-sm text-ink-faint transition hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> All posts
      </Link>

      <header className="mt-6">
        <h1 className="font-serif text-4xl font-semibold leading-tight tracking-tight text-ink">
          {post.title}
        </h1>
        <p className="mt-4 text-sm text-ink-faint">
          {post.author ? <span>{post.author}</span> : null}
          {post.author && date ? <span aria-hidden> · </span> : null}
          {date ? <time dateTime={post.published_at ?? undefined}>{date}</time> : null}
        </p>
      </header>

      {post.cover_image ? (
        <div className="relative mt-8 aspect-[16/9] w-full overflow-hidden rounded-xl bg-paper-shade shadow-lift">
          {/* Plain <img>: covers come from the CMS on hosts we don't want to
              hard-code into next.config's image allowlist. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={post.cover_image}
            alt={post.cover_image_alt ?? ""}
            className="absolute inset-0 h-full w-full object-cover"
          />
        </div>
      ) : null}

      <div
        className="mt-10 text-base leading-relaxed text-ink-soft [&_a:hover]:text-terracotta [&_a]:text-terracotta-dark [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-ink/15 [&_blockquote]:pl-4 [&_blockquote]:text-ink-faint [&_code]:rounded-sm [&_code]:bg-ink/5 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-sm [&_h2]:mt-10 [&_h2]:font-serif [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:text-ink [&_h3]:mt-8 [&_h3]:font-serif [&_h3]:text-xl [&_h3]:font-semibold [&_h3]:text-ink [&_img]:my-6 [&_img]:rounded-lg [&_li]:leading-relaxed [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-6 [&_p]:my-5 [&_strong]:font-semibold [&_strong]:text-ink [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6"
        dangerouslySetInnerHTML={{ __html: post.content ?? "" }}
      />

      {sources.length > 0 ? (
        <section className="mt-14 border-t border-ink/10 pt-8">
          <h2 className="font-serif text-lg font-semibold text-ink">Sources</h2>
          <ul className="mt-4 space-y-2 text-sm">
            {sources.map((s, i) => (
              <li key={i}>
                <a
                  href={s.url ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="text-terracotta-dark underline transition hover:text-terracotta"
                >
                  {s.title || s.url}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {post.author && post.author_profile?.bio ? (
        <section className="mt-12 rounded-xl bg-paper-shade p-6 shadow-card">
          <p className="text-sm font-semibold text-ink">{post.author}</p>
          {post.author_profile.role ? (
            <p className="text-sm text-ink-faint">{post.author_profile.role}</p>
          ) : null}
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">{post.author_profile.bio}</p>
        </section>
      ) : null}
    </article>
  );
}
