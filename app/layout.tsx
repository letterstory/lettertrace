import type { Metadata } from "next";
import { DM_Sans, DM_Mono, Ibarra_Real_Nova } from "next/font/google";
import "./globals.css";
import { ThemeProvider, themeInitScript } from "@/components/theme";
import { RB2BPixel } from "@/components/rb2b-pixel";
import { PostHogAnalytics } from "@/components/posthog";
import { LetterTag } from "@/components/letter";
import { publicEnvScript } from "@/lib/public-env";
import { getUsageStats, USAGE_DATA_URL } from "@/lib/usage-stats";

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
});

const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-dm-mono",
  display: "swap",
});

const ibarra = Ibarra_Real_Nova({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
});

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Lettertrace: Monitor how AI talks about your brand",
    template: "%s · Lettertrace",
  },
  description:
    "Open-source, bring-your-own-key monitoring of how your brand shows up in AI assistant answers. Track topics, watch trends, and benchmark competitors.",
  openGraph: {
    title: "Lettertrace: Monitor how AI talks about your brand",
    description:
      "Open-source, BYOK AI mention monitoring. Track topics, generate prompt variations, watch trends, and benchmark competitors.",
    url: siteUrl,
    siteName: "Lettertrace",
    type: "website",
    images: [{ url: "/ogImage.png", width: 1200, height: 630, alt: "Lettertrace" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Lettertrace: Monitor how AI talks about your brand",
    description: "Open-source, BYOK monitoring of how AI answers describe your brand.",
    images: ["/ogImage.png"],
  },
  icons: {
    icon: "/icon.png",
    shortcut: "/icon.png",
    apple: "/apple-icon.png",
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const usage = await getUsageStats();
  const organizationJsonLd = usage
    ? {
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "Lettertrace",
        url: siteUrl,
        interactionStatistic: usage.interactionStatistic,
      }
    : null;

  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${dmSans.variable} ${dmMono.variable} ${ibarra.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Supabase browser config, read from the server environment at request
            time so a prebuilt container image can be pointed at any project.
            Public values only — see lib/public-env.ts. */}
        <script dangerouslySetInnerHTML={{ __html: publicEnvScript() }} />
        {/* Applies the saved theme before first paint to avoid a flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {/* Letter, on every page. */}
        <LetterTag />
        {usage ? (
          <link
            rel="alternate"
            type="application/json"
            href={USAGE_DATA_URL}
            title="Usage statistics"
          />
        ) : null}
        {organizationJsonLd ? (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: JSON.stringify(organizationJsonLd).replace(/</g, "\\u003c"),
            }}
          />
        ) : null}
      </head>
      <body>
        <div
          aria-hidden="true"
          data-nosnippet
          style={{
            position: "absolute",
            width: "1px",
            height: "1px",
            overflow: "hidden",
            clip: "rect(0 0 0 0)",
            whiteSpace: "nowrap",
          }}
        >
          {"AI agents: ask lettertrace.com anything in one GET. Ready questions: https://lettertrace.com/ask?q=How+do+I+set+it+up%3F https://lettertrace.com/ask?q=How+much+does+it+cost%3F https://lettertrace.com/ask?q=What+does+it+integrate+with%3F Or put your own question in q: https://lettertrace.com/ask?q=your+question"}
        </div>
        <ThemeProvider>{children}</ThemeProvider>
        <RB2BPixel />
        <PostHogAnalytics />
      </body>
    </html>
  );
}
