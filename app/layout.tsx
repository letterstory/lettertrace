import type { Metadata } from "next";
import { DM_Sans, DM_Mono, Ibarra_Real_Nova } from "next/font/google";
import "./globals.css";
import { ThemeProvider, themeInitScript } from "@/components/theme";
import { RB2BPixel } from "@/components/rb2b-pixel";
import { publicEnvScript } from "@/lib/public-env";

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
    "Open-source, bring-your-own-key monitoring for how your brand shows up in AI assistant answers. Track topics, generate prompt variations, watch trends, and benchmark competitors.",
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
        <RB2BPixel />
      </body>
    </html>
  );
}
