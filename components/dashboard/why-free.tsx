"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

// A plain text link for the dashboard sidebar that opens a short explainer
// video answering "Why is this free?". Its own "use client" island so the
// server-rendered dashboard layout stays a server component.

// youtu.be/pQNaLHnxY8c -> privacy-friendly embed, autoplay on open,
// captions off by default (cc_load_policy=0).
const VIDEO_EMBED_URL =
  "https://www.youtube-nocookie.com/embed/pQNaLHnxY8c?autoplay=1&rel=0&cc_load_policy=0";

export function WhyFree({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "text-left text-xs text-ink-faint underline-offset-2 transition hover:text-ink hover:underline",
          className,
        )}
      >
        Why is this free?
      </button>
      {open && <WhyFreeDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function WhyFreeDialog({ onClose }: { onClose: () => void }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Escape to close; lock body scroll while the dialog is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="why-free-title"
    >
      <div
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm animate-fade-up"
        onClick={onClose}
      />
      <div className="relative w-full max-w-2xl overflow-hidden rounded border border-ink/10 bg-paper shadow-lift animate-fade-up">
        <div className="flex items-center justify-between border-b border-ink/10 px-5 py-4">
          <h2 id="why-free-title" className="text-lg font-semibold tracking-tight text-ink">
            Why is this free?
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-[2px] text-ink-soft transition hover:bg-ink/[0.05] hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="p-5">
          <div className="overflow-hidden rounded border border-ink/10">
            <iframe
              src={VIDEO_EMBED_URL}
              title="Why is this free?"
              className="aspect-video w-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
