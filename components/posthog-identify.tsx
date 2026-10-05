"use client";

import { useEffect } from "react";
import posthog from "posthog-js";
import {
  identifyTraits,
  shouldCaptureSignup,
  signupEventProperties,
} from "@/lib/posthog-client-events";
import { ensureProductPosthog } from "@/components/posthog-browser";

/**
 * Links the anonymous homepage visit to this account, and records a signup
 * the first time that account is seen. Mounted once in the dashboard layout
 * because every signed-in user passes through it, including password signups
 * that never visit /auth/callback.
 */
export function PostHogIdentify({
  userId,
  email,
  signupMethod,
  firstSignIn,
}: {
  userId: string;
  email?: string | null;
  signupMethod: string;
  firstSignIn: boolean;
}) {
  useEffect(() => {
    if (!ensureProductPosthog()) return;
    posthog.identify(userId, identifyTraits(email));
    if (!shouldCaptureSignup(firstSignIn, window.sessionStorage)) return;
    posthog.capture("user_signed_up", signupEventProperties(signupMethod, email));
  }, [userId, email, signupMethod, firstSignIn]);

  return null;
}
