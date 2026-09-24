"use client";

import { useEffect, useRef } from "react";

// A soft lamp that follows the pointer across its parent section. The parent
// must be position: relative. Touch pointers are ignored.
export function CursorLight({ color = "224 120 80", strength = 0.14 }: { color?: string; strength?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const r = host.getBoundingClientRect();
      el.style.setProperty("--lx", `${e.clientX - r.left}px`);
      el.style.setProperty("--ly", `${e.clientY - r.top}px`);
    };
    host.addEventListener("pointermove", onMove);
    return () => host.removeEventListener("pointermove", onMove);
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0"
      style={{
        background: `radial-gradient(circle 420px at var(--lx, 50%) var(--ly, 30%), rgb(${color} / ${strength}), transparent 70%)`,
      }}
    />
  );
}
