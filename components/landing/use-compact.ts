"use client";

import { useEffect, useState } from "react";

// True below the sm breakpoint. Charts switch to a narrower viewBox there, so
// their SVG text renders at a readable size instead of being scaled down.
export function useCompact(query = "(max-width: 639px)") {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setCompact(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return compact;
}
