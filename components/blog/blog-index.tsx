import Link from "next/link";
import type { PublishedArticle } from "@/lib/blog";
import { formatPostDate } from "@/components/blog/format";

// The /blog index: a simple, readable list of published posts, newest first.
// Styling uses the shared Lettertrace palette tokens (paper/ink/terracotta) so
// it sits inside the same visual system as the rest of the site.
export default function BlogIndex({ posts }: { posts: PublishedArticle[] }) {
  return (
    <div className="mx-auto max-w-3xl px-5 py-14">
      <header className="mb-12">
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-ink">Blog</h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-ink-soft">
          Writing from the Lettertrace team on AEO, generative-engine optimization, and how AI
          assistants talk about brands.
        </p>
      </header>

      {posts.length === 0 ? (
        <p className="text-ink-faint">No posts yet. Check back soon.</p>
      ) : (
        <ul className="space-y-10">
          {posts.map((post) => {
            const date = formatPostDate(post.published_at);
            return (
              <li key={post.slug} className="border-b border-ink/10 pb-10 last:border-0">
                <Link href={`/blog/${post.slug}`} className="group block">
                  <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                    {post.cover_image ? (
                      <div className="relative aspect-[16/10] w-full shrink-0 overflow-hidden rounded-lg bg-paper-shade shadow-card sm:h-28 sm:w-44">
                        {/* Plain <img>: covers come from the CMS on hosts we don't
                            want to hard-code into next.config's image allowlist. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={post.cover_image}
                          alt={post.cover_image_alt ?? ""}
                          loading="lazy"
                          className="absolute inset-0 h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
                        />
                      </div>
                    ) : null}
                    <div className="min-w-0">
                      <h2 className="font-serif text-2xl font-semibold leading-snug text-ink transition group-hover:text-terracotta-dark">
                        {post.title}
                      </h2>
                      {post.summary ? (
                        <p className="mt-2 line-clamp-2 text-base leading-relaxed text-ink-soft">
                          {post.summary}
                        </p>
                      ) : null}
                      <p className="mt-3 text-sm text-ink-faint">
                        {post.author ? <span>{post.author}</span> : null}
                        {post.author && date ? <span aria-hidden> · </span> : null}
                        {date ? <time dateTime={post.published_at ?? undefined}>{date}</time> : null}
                      </p>
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
