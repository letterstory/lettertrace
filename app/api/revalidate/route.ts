import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { BLOG_CACHE_TAG } from "@/lib/blog";

/**
 * On-demand revalidation webhook — the "rebuild on publish" hook for
 * lettertrace.com/blog.
 *
 * app.letterstory.com POSTs here whenever content in a collection is published
 * (see rebuildBlogsForCollection). We bust the "blog" cache tag so the next
 * request re-fetches the published API and re-renders /blog + /blog/[slug].
 *
 * Auth: a shared secret passed as `?secret=` (compared against
 * BLOG_REVALIDATE_SECRET). The app fans out to every consumer on every publish,
 * so we filter to this blog's own collection when the caller sends
 * `{ collection_id }` — an unrelated collection's publish is a no-op here.
 *
 * Inert on forks / self-host: with BLOG_REVALIDATE_SECRET unset, every call 401s.
 *
 *   POST /api/revalidate?secret=...   body: { "collection_id": "<uuid>" }  (optional)
 */
export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  const expected = process.env.BLOG_REVALIDATE_SECRET;
  if (!expected || secret !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let collectionId: string | null = null;
  try {
    const body = (await req.json()) as { collection_id?: string } | null;
    collectionId = body?.collection_id ?? null;
  } catch {
    // No/invalid body — treat as an unconditional revalidate.
  }

  const want = process.env.BLOG_COLLECTION_ID;
  if (collectionId && want && collectionId !== want) {
    return NextResponse.json({ ok: true, revalidated: false, reason: "other-collection" });
  }

  revalidateTag(BLOG_CACHE_TAG);
  return NextResponse.json({ ok: true, revalidated: true });
}
