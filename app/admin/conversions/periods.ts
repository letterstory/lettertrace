import type { Period } from "@/lib/conversions";

/** The dropdown's options, in a module with no "use client" directive: the
 *  server page needs to .find() a label and a client module's exports are
 *  opaque references on the server, while lib/conversions.ts pulls in the
 *  service-role client and must stay out of the client bundle. This file is
 *  importable from both sides. */
export const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "ytd", label: "Year to date" },
  { value: "all", label: "All time" },
];
