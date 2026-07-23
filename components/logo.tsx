import Image from "next/image";
import { cn } from "@/lib/utils";

// The Lettertrace brand lockup. Real brand assets live in /public/images.
// Every in-app placement sits on a light surface, so the black wordmark is the
// default; pass variant="light" on dark backgrounds. showWord={false} renders
// just the petal mark.
//
// The <Image> is wrapped in an inline-flex, width-fit span so it never gets
// stretched when it's a direct flex child (e.g. the flex-col dashboard sidebar,
// where align-items:stretch would otherwise distort a w-auto image).
export function Logo({
  className,
  variant = "dark",
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

  const src = variant === "light" ? "/images/logo_white.png" : "/images/logo_black.png";
  return (
    <span className={cn("inline-flex w-fit shrink-0", className)}>
      <Image
        src={src}
        alt="Lettertrace"
        width={705}
        height={138}
        className="h-7 w-auto"
      />
    </span>
  );
}
