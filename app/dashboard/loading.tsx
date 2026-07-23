import { PageSkeleton } from "@/components/dashboard/page-skeleton";

// Entry boundary for /dashboard itself; sibling tabs each have their own
// loading.tsx (a parent boundary doesn't re-trigger on sibling navigation).
export default function DashboardLoading() {
  return <PageSkeleton />;
}
