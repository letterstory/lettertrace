/**
 * Masking for identifiers shown on the operations dashboard.
 *
 * The page is already behind an allowlist, so this is not access control. It is
 * for the screen itself: an ops dashboard gets opened in meetings, screenshared
 * while debugging, and photographed into tickets. Full addresses and complete
 * uuids leave that surface for no benefit — you only ever need enough to tell
 * one row from another.
 *
 * Enough is the point. Truncating to nothing would make two operators
 * indistinguishable, which defeats the list; these keep the domain and both
 * ends of the uuid, so a person can still confirm at a glance which entry is
 * theirs and spot the id they just pasted.
 */

/** casey@letterbrace.com -> ca•••@letterbrace.com */
export function maskEmail(email: string | null | undefined): string {
  const value = email?.trim();
  if (!value) return "—";
  const at = value.lastIndexOf("@");
  if (at <= 0) return maskMiddle(value);
  const local = value.slice(0, at);
  const domain = value.slice(at);
  // The domain stays: it is the part that says "this is one of ours", and it
  // is not a secret on a page listing your own team.
  // Head AND tail, not just head: "mahir" and "mathew" share their first two
  // characters, so a head-only mask renders two different operators as the
  // same row. Distinguishable is the requirement; the tail character is what
  // buys it, at a cost of one letter.
  if (local.length >= 4) {
    return `${local.slice(0, 2)}•••${local.slice(-1)}${domain}`;
  }
  return `${local.slice(0, 1)}•••${domain}`;
}

/** 295ba806-a99a-4bc1-903b-2584a2e103b0 -> 295ba806…03b0 */
export function maskUuid(id: string | null | undefined): string {
  const value = id?.trim();
  if (!value) return "—";
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function maskMiddle(value: string): string {
  if (value.length <= 4) return "•".repeat(value.length);
  return `${value.slice(0, 2)}•••${value.slice(-2)}`;
}
