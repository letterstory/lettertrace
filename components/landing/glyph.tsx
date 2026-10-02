"use client";

import { useEffect, useRef, useState } from "react";
import { GLYPH_TILES } from "./glyph-tiles";

// The mark assembling itself: each tile drifts in from a scattered position
// and settles on the grid. Triggers once, when it scrolls into view. The same
// motion closes phantomstory.com, so the Letter Company sites read as a family.

// Deterministic scatter per tile so server and client render the same thing.
function scatter(i: number) {
  const a = Math.sin(i * 12.9898 + 3) * 43758.5453;
  const b = Math.sin(i * 78.233 + 1) * 12345.6789;
  const fx = a - Math.floor(a);
  const fy = b - Math.floor(b);
  const x = (fx - 0.5) * 240;
  const y = (fy - 0.5) * 240;
  const r = (fx > 0.5 ? 1 : -1) * (90 + Math.round(fy * 2) * 90);
  return `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${r}deg) scale(0.4)`;
}

export function AssemblingGlyph({
  petal,
  core,
  className,
}: {
  petal: string;
  core: string;
  className?: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOn(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setOn(true);
          io.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <svg ref={ref} viewBox="0 0 256 256" className={className} aria-hidden="true">
      {GLYPH_TILES.map((t, i) => (
        <path
          key={i}
          d={t.d}
          fill={t.role === "petal" ? petal : core}
          style={{
            transformBox: "fill-box",
            transformOrigin: "center",
            transform: on ? "none" : scatter(i),
            opacity: on ? 1 : 0,
            transition:
              "transform 1.1s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.8s ease",
            transitionDelay: `${i * 80}ms`,
          }}
        />
      ))}
    </svg>
  );
}
