// Instant skeleton shown while any dashboard page's server render is in
// flight, so navigation clicks respond immediately instead of feeling frozen.
// Generic shape: heading, stat row, and content cards.
export default function DashboardLoading() {
  return (
    <div className="animate-pulse space-y-8" aria-hidden>
      <div className="space-y-2.5">
        <div className="h-8 w-52 rounded-xl bg-ink/[0.06]" />
        <div className="h-4 w-80 max-w-full rounded-lg bg-ink/[0.05]" />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 rounded-2xl bg-ink/[0.05]" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="h-80 rounded-2xl bg-ink/[0.05] lg:col-span-2" />
        <div className="h-80 rounded-2xl bg-ink/[0.05]" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="h-64 rounded-2xl bg-ink/[0.05]" />
        <div className="h-64 rounded-2xl bg-ink/[0.05]" />
      </div>
    </div>
  );
}
