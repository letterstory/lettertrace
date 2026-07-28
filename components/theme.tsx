"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------
// Theme system. Dark is the default; the user can switch to light and
// the choice persists in localStorage. The initial attribute is set by
// an inline script in the root layout (see themeInitScript) so there is
// no flash before hydration.
// ------------------------------------------------------------------

export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "lettertrace-theme";
export const DEFAULT_THEME: Theme = "dark";

// Runs before paint (injected in <head>). Reads the saved choice and applies
// it to <html> so the first frame already matches. Kept dependency-free and
// stringified — it must run without React.
export const themeInitScript = `(function(){try{var k="${THEME_STORAGE_KEY}";var s=localStorage.getItem(k);var t=s==="light"||s==="dark"?s:"${DEFAULT_THEME}";var r=document.documentElement;r.dataset.theme=t;r.style.colorScheme=t;}catch(e){}})();`;

function readTheme(): Theme {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.dataset.theme;
    if (attr === "light" || attr === "dark") return attr;
  }
  return DEFAULT_THEME;
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // ignore write failures (private mode, blocked storage)
  }
}

interface ThemeContextValue {
  theme: Theme;
  mounted: boolean;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Initialise to the default for a stable server/first-client render; the
  // effect below syncs to whatever the inline script already applied.
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setThemeState(readTheme());
    setMounted(true);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyTheme(next);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, mounted, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx) return ctx;
  // Fallback for any consumer rendered outside the provider.
  return {
    theme: readTheme(),
    mounted: true,
    setTheme: () => {},
    toggle: () => {},
  };
}

// Compact icon button — for pre-auth headers (landing, login).
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, mounted, toggle } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded border border-ink/15 text-ink-soft transition hover:border-ink/35 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40",
        className,
      )}
    >
      {/* Render a stable icon until mounted to avoid hydration mismatch. */}
      {mounted && !isDark ? (
        <Sun className="h-4 w-4" aria-hidden />
      ) : (
        <Moon className="h-4 w-4" aria-hidden />
      )}
    </button>
  );
}

// Labeled switch — for the sidebar and the settings "Appearance" card.
export function ThemeSwitch({
  className,
  showLabel = true,
}: {
  className?: string;
  showLabel?: boolean;
}) {
  const { theme, mounted, toggle } = useTheme();
  const isDark = theme === "dark";
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      {showLabel && (
        <span className="inline-flex items-center gap-2 text-sm font-medium text-ink-soft">
          {isDark ? <Moon className="h-4 w-4" aria-hidden /> : <Sun className="h-4 w-4" aria-hidden />}
          {mounted ? (isDark ? "Dark" : "Light") : "Theme"}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={!isDark}
        aria-label="Toggle light mode"
        onClick={toggle}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded transition focus:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/40",
          isDark ? "bg-ink/15" : "bg-terracotta",
        )}
      >
        <span
          className={cn(
            "inline-block h-4 w-4 transform rounded-sm bg-white shadow-sm transition",
            isDark ? "translate-x-1" : "translate-x-6",
          )}
        />
      </button>
    </div>
  );
}
