import type { Metadata } from "next";
import { DM_Sans, DM_Mono, Ibarra_Real_Nova } from "next/font/google";
import "./globals.css";
import { ThemeProvider, themeInitScript } from "@/components/theme";

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
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Lettertrace" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Lettertrace: Monitor how AI talks about your brand",
    description: "Open-source, BYOK monitoring of how AI answers describe your brand.",
    images: ["/og.png"],
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
        {/* Applies the saved theme before first paint to avoid a flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
