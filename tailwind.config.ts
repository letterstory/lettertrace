import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Lettertrace palette, resampled directly from the brand mark:
        // cream #F5F4F0, aqua-mint petals #A8F0DC, terracotta petal #E07850.
        //
        // Every token resolves to a CSS variable (an "R G B" triple) so the
        // whole UI can flip between the dark default and the light theme by
        // swapping the variables in globals.css. `<alpha-value>` keeps Tailwind
        // opacity modifiers (e.g. `text-ink/60`) working.
        ink: {
          DEFAULT: "rgb(var(--c-ink) / <alpha-value>)", // primary text
          soft: "rgb(var(--c-ink-soft) / <alpha-value>)",
          faint: "rgb(var(--c-ink-faint) / <alpha-value>)",
        },
        paper: {
          DEFAULT: "rgb(var(--c-paper) / <alpha-value>)", // page background
          shade: "rgb(var(--c-paper-shade) / <alpha-value>)",
          deep: "rgb(var(--c-paper-deep) / <alpha-value>)",
        },
        surface: "rgb(var(--c-surface) / <alpha-value>)", // cards / raised
        // Brand accent (the standout petal). `dark` is the text-on-tint role:
        // a deep shade in light mode, a light shade in dark mode.
        terracotta: {
          DEFAULT: "rgb(var(--c-terracotta) / <alpha-value>)",
          dark: "rgb(var(--c-terracotta-ink) / <alpha-value>)",
          soft: "rgb(var(--c-terracotta-soft) / <alpha-value>)",
        },
        // Deep aqua, the readable sibling of the mint petals.
        teal: {
          DEFAULT: "rgb(var(--c-teal) / <alpha-value>)",
          dark: "rgb(var(--c-teal-ink) / <alpha-value>)",
          soft: "rgb(var(--c-teal-soft) / <alpha-value>)",
        },
        // The mint petal itself (fills, positive sentiment, glows).
        // `tint` is a solid chip background, `ink` the paired text role.
        mint: {
          DEFAULT: "rgb(var(--c-mint) / <alpha-value>)",
          bright: "rgb(var(--c-mint-bright) / <alpha-value>)",
          soft: "rgb(var(--c-mint-soft) / <alpha-value>)",
          tint: "rgb(var(--c-mint-tint) / <alpha-value>)",
          ink: "rgb(var(--c-mint-ink) / <alpha-value>)",
        },
        butter: {
          DEFAULT: "rgb(var(--c-butter) / <alpha-value>)", // warm amber support
          tint: "rgb(var(--c-butter-tint) / <alpha-value>)",
          ink: "rgb(var(--c-butter-ink) / <alpha-value>)",
        },
        sand: {
          DEFAULT: "rgb(var(--c-sand) / <alpha-value>)", // warm neutral
          soft: "rgb(var(--c-sand-soft) / <alpha-value>)",
          tint: "rgb(var(--c-sand-tint) / <alpha-value>)",
        },
        // Always-dark code/terminal surface (kept dark in both themes).
        terminal: {
          DEFAULT: "rgb(var(--c-terminal) / <alpha-value>)",
          ink: "rgb(var(--c-terminal-ink) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["var(--font-dm-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        serif: ["var(--font-serif)", "ui-serif", "Georgia", "serif"],
        mono: ["var(--font-dm-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(26,25,23,0.04), 0 6px 20px rgba(26,25,23,0.05)",
        lift: "0 2px 4px rgba(26,25,23,0.05), 0 16px 40px rgba(26,25,23,0.09)",
        glow: "0 0 0 1px rgba(224,120,80,0.15), 0 12px 40px rgba(224,120,80,0.18)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        blink: {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.6s cubic-bezier(0.22,1,0.36,1) both",
        blink: "blink 1.1s step-end infinite",
      },
    },
  },
  plugins: [],
};

export default config;
