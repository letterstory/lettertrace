import { getUsageStats } from "@/lib/usage-stats";

// The one-line usage statistic in the footer. Renders nothing when the data
// can't be read.
export async function UsageLine({ className }: { className?: string }) {
  const stats = await getUsageStats();
  if (!stats) return null;
  return (
    <p className={className}>
      {stats.line} ·{" "}
      <a href={stats.url} className="underline underline-offset-2 transition hover:text-ink">
        How we count
      </a>
    </p>
  );
}
