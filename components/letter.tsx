"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Letter: counts people on every page and powers Letter Edit (⌘L).
 *
 * Rendered once in the root layout's <head>, so every page gets it. Pages
 * behind sign-in get the same tag with data-identification="off": nobody
 * signed in is ever identified by it. The tag body is Letter's snippet
 * verbatim; the key is publishable, not a secret.
 */
const LETTER_TAG = `(function(w,d){var h=null;try{var l=w.localStorage,p=JSON.parse(l.getItem("lv:vp:"+"lv_pub_8fi1qwb4jj9rxu2m3123pd85")||"[]"),q=(location.pathname||"/").replace(/\\/{2,}/g,"/").replace(/(.)\\/+$/,"$1");if(p.indexOf(q)>=0){w.__lvHeld=1;h=d.createElement("style");h.textContent="html{opacity:0!important}";d.head.appendChild(h)}}catch(e){}w.__lvReveal=function(){if(h&&h.parentNode)h.parentNode.removeChild(h);h=null};setTimeout(function(){if(h)w.__lvLate=1;w.__lvReveal()},300);var s=d.createElement("script");s.src="https://lettervisit.com/v.js?k=lv_pub_8fi1qwb4jj9rxu2m3123pd85";s.async=true;s.setAttribute("data-key","lv_pub_8fi1qwb4jj9rxu2m3123pd85");s.onerror=w.__lvReveal;d.head.appendChild(s)})(window,document)`;

// Routes only reachable signed in (see lib/supabase/middleware.ts).
const SIGNED_IN_PATHS = ["/dashboard", "/admin", "/invite", "/oauth"];

function isSignedInPath(pathname: string): boolean {
  return SIGNED_IN_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function LetterTag() {
  const pathname = usePathname() ?? "/";
  if (isSignedInPath(pathname)) {
    return <script data-identification="off" dangerouslySetInnerHTML={{ __html: LETTER_TAG }} />;
  }
  return <script dangerouslySetInnerHTML={{ __html: LETTER_TAG }} />;
}

type LetterCall = (...args: unknown[]) => void;

function letter(...args: unknown[]) {
  const w = window as unknown as { lettervisit?: LetterCall & { q?: unknown[] } };
  w.lettervisit =
    w.lettervisit ||
    function (...a: unknown[]) {
      (w.lettervisit!.q = w.lettervisit!.q || []).push(a);
    };
  w.lettervisit(...args);
}

const SIGNUP_FLAG = "lettertrace:letter-signed-up";

/** Tells Letter who is signed in, and which organization they are working in. */
export function LetterIdentify({
  userId,
  email,
  account,
  firstSignIn,
}: {
  userId: string;
  email?: string | null;
  account?: string | null;
  firstSignIn: boolean;
}) {
  const pathname = usePathname();

  useEffect(() => {
    letter("identify", email?.trim() || userId);
    if (account) letter("group", account);
  }, [pathname, userId, email, account]);

  useEffect(() => {
    if (!firstSignIn) return;
    try {
      if (window.sessionStorage.getItem(SIGNUP_FLAG)) return;
      window.sessionStorage.setItem(SIGNUP_FLAG, "1");
    } catch {
      return;
    }
    letter("track", "signup");
  }, [firstSignIn]);

  return null;
}
