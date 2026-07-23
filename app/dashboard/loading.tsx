// Instant skeleton shown while any dashboard page's server render is in
// flight, so navigation clicks respond immediately instead of feeling frozen.
// Generic shape: heading, stat row, and content cards, with a shimmer sweep.
export default function DashboardLoading() {
  return (
    <div className="space-y-8" aria-hidden>
      <div className="space-y-2.5">
        <div className="shimmer h-8 w-52 rounded-xl" />
        <div className="shimmer h-4 w-80 max-w-full rounded-lg" />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="shimmer h-28 rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="shimmer h-80 rounded-2xl lg:col-span-2" />
        <div className="shimmer h-80 rounded-2xl" />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="shimmer h-64 rounded-2xl" />
        <div className="shimmer h-64 rounded-2xl" />
      </div>
    </div>
  );
}
