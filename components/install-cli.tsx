"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Sparkles, Terminal, X } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

// The "Install the CLI" hero action. Opens a small dialog with two ways to get
// the CLI: a prompt to hand a coding agent, or the plain npm one-liner. Its own
// "use client" island so the server-rendered landing page stays static.

const NPM_COMMAND = "npm install -g lettertrace";

const AGENT_PROMPT =
  "Install and set up the Lettertrace CLI for me. Run `npm install -g lettertrace`, " +
  "then `lettertrace login` to authenticate in the browser. Once I'm signed in, create a " +
  "project for my brand and trigger a first monitoring run so I can see how AI assistants describe us.";

type Tab = "agent" | "npm";

export function InstallCli({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="secondary"
        size="lg"
        className={className}
        onClick={() => setOpen(true)}
      >
        <Terminal className="h-4 w-4" />
        Install the CLI
      </Button>
      {open && <InstallDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function InstallDialog({ onClose }: { onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState<Tab>("agent");

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
      aria-labelledby="install-cli-title"
    >
      <div
        className="absolute inset-0 bg-ink/40 backdrop-blur-sm animate-fade-up"
        onClick={onClose}
      />
      <div className="relative w-full max-w-lg overflow-hidden rounded border border-ink/10 bg-paper shadow-lift animate-fade-up">
        <div className="flex items-center justify-between border-b border-ink/10 px-5 py-4">
          <h2 id="install-cli-title" className="text-lg font-semibold tracking-tight text-ink">
            Install the CLI
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

        <div className="flex gap-1 border-b border-ink/10 px-5 pt-3">
          <TabButton active={tab === "agent"} onClick={() => setTab("agent")} icon={Sparkles}>
            Coding Agent
          </TabButton>
          <TabButton active={tab === "npm"} onClick={() => setTab("npm")} icon={Terminal}>
            Install via npm
          </TabButton>
        </div>

        <div className="p-5">
          {tab === "agent" ? (
            <div>
              <p className="mb-3 text-sm text-ink-soft">
                Paste this prompt into your coding agent (Claude Code, Cursor, and the like).
              </p>
              <CopyBlock text={AGENT_PROMPT} multiline />
            </div>
          ) : (
            <div>
              <p className="mb-3 text-sm text-ink-soft">
                Requires Node.js 20 or newer. Then run <span className="font-mono text-ink">lettertrace login</span>.
              </p>
              <CopyBlock text={NPM_COMMAND} />
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Sparkles;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
        active
          ? "border-ink text-ink"
          : "border-transparent text-ink-soft hover:text-ink",
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {children}
    </button>
  );
}

function CopyBlock({ text, multiline = false }: { text: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked; the text is still selectable */
    }
  };

  return (
    <div className="relative rounded border border-white/10 bg-terminal text-terminal-ink">
      <pre
        className={cn(
          "overflow-x-auto p-4 pr-12 font-mono text-[13px] leading-relaxed",
          multiline ? "whitespace-pre-wrap" : "whitespace-pre",
        )}
      >
        {!multiline && <span className="text-mint-bright">$ </span>}
        {text}
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy to clipboard"}
        title={copied ? "Copied" : "Copy"}
        className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-[2px] text-white/50 transition hover:bg-white/10 hover:text-white"
      >
        {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      </button>
    </div>
  );
}
