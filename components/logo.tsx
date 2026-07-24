import Image from "next/image";
import { cn } from "@/lib/utils";

// The Lettertrace brand lockup. Real brand assets live in /public/images.
// By default the wordmark follows the active theme: the black lockup shows in
// light mode, the white lockup in dark mode. The swap is pure CSS keyed off
// html[data-theme] (see the .logo-for-* rules in globals.css), so it reacts to
// the runtime toggle with no flash and no client JS. Pass an explicit
// variant to pin one asset. showWord={false} renders just the petal mark.
//
// The <Image> is wrapped in an inline-flex, width-fit span so it never gets
// stretched when it's a direct flex child (e.g. the flex-col dashboard sidebar,
// where align-items:stretch would otherwise distort a w-auto image).
export function Logo({
  className,
  variant,
  showWord = true,
}: {
  className?: string;
  variant?: "dark" | "light";
  showWord?: boolean;
}) {
  if (!showWord) {
    return (
      <span className={cn("inline-flex w-fit shrink-0", className)}>
        <Image src="/icon.png" alt="Lettertrace" width={256} height={256} className="h-8 w-8" />
      </span>
    );
  }

  // Explicit override: render a single asset.
  if (variant) {
    const src = variant === "light" ? "/images/logo_white.png" : "/images/logo_black.png";
    return (
      <span className={cn("inline-flex w-fit shrink-0", className)}>
        <Image src={src} alt="Lettertrace" width={705} height={138} className="h-7 w-auto" />
      </span>
    );
  }

  // Auto (default): render both; CSS reveals the one matching the theme.
  return (
    <span className={cn("inline-flex w-fit shrink-0", className)}>
      <Image
        src="/images/logo_black.png"
        alt="Lettertrace"
        width={705}
        height={138}
        className="logo-for-light h-7 w-auto"
      />
      <Image
        src="/images/logo_white.png"
        alt="Lettertrace"
        width={705}
        height={138}
        className="logo-for-dark h-7 w-auto"
      />
    </span>
  );
}
