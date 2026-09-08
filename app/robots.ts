import type { MetadataRoute } from "next";

// robots.txt for lettertrace.com. Points crawlers at the sitemap (so /blog gets
// discovered) and keeps them out of the authenticated app + machine surfaces —
// those only ever return auth redirects to a bot, so there's nothing to index.
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://lettertrace.com").replace(/\/+$/, "");

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/dashboard", "/admin", "/oauth", "/auth/", "/login", "/activate", "/invite/"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
