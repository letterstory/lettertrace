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
        ink: {
          DEFAULT: "#1A1917", // warm near-black (wordmark)
          soft: "#45423C",
          faint: "#7C786F",
        },
        paper: {
          DEFAULT: "#F5F4F0", // sampled cream background
          shade: "#EDEAE1",
          deep: "#E1DDD1",
        },
        surface: "#FFFFFF",
        // Brand accent (the standout petal).
        terracotta: {
          DEFAULT: "#E07850",
          dark: "#B9552F",
          soft: "#F0AD90",
        },
        // Deep aqua, the readable sibling of the mint petals.
        teal: {
          DEFAULT: "#129C82",
          dark: "#0C6E5B",
          soft: "#74C9B7",
        },
        // The mint petal itself (fills, positive sentiment, glows).
        mint: {
          DEFAULT: "#A8F0DC",
          bright: "#82EAD1",
          soft: "#D6F6EE",
        },
        butter: "#E8C67C", // warm amber support
        sand: {
          DEFAULT: "#CBB9A0", // warm neutral
          soft: "#E4DAC9",
        },
      },
      fontFamily: {
        sans: ["var(--font-dm-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        serif: ["var(--font-serif)", "ui-serif", "Georgia", "serif"],
        mono: ["var(--font-dm-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        "4xl": "2rem",
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
