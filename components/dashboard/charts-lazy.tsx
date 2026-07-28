"use client";

import dynamic from "next/dynamic";

// Lazy entrypoints for the recharts-based charts. Recharts is by far the
// heaviest client dependency; loading it on demand keeps it out of the shared
// dashboard bundle so first paint isn't blocked on chart code.

function ChartSkeleton({ height }: { height: number }) {
  return <div className="shimmer rounded" style={{ height }} aria-hidden />;
}

export const TrendChart = dynamic(() => import("./charts").then((m) => m.TrendChart), {
  ssr: false,
  loading: () => <ChartSkeleton height={280} />,
});

export const ShareBars = dynamic(() => import("./charts").then((m) => m.ShareBars), {
  ssr: false,
  loading: () => <ChartSkeleton height={180} />,
});

export const SentimentDonut = dynamic(() => import("./charts").then((m) => m.SentimentDonut), {
  ssr: false,
  loading: () => <ChartSkeleton height={240} />,
});
