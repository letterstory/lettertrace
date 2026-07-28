"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { safePath } from "@/lib/utils";
import { Button, Input, Label, Spinner } from "@/components/ui";
import { GithubIcon, GoogleIcon } from "@/components/brand-icons";

type Mode = "signin" | "signup";
type OAuthProvider = "google" | "github";

// Sign-in providers configured in Supabase (Authentication → Providers). Adding
// one here is the only client-side change a new provider needs — the callback
// route and the profiles trigger are provider-agnostic.
const oauthProviders: { id: OAuthProvider; label: string; Icon: typeof GoogleIcon }[] = [
  { id: "google", label: "Google", Icon: GoogleIcon },
  { id: "github", label: "GitHub", Icon: GithubIcon },
];

export function AuthForm({
  next,
  mode,
  initialError,
}: {
  next?: string;
  mode?: string;
  initialError?: string;
}) {
  const router = useRouter();
  const [authMode, setAuthMode] = useState<Mode>(mode === "signup" ? "signup" : "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<OAuthProvider | null>(null);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [confirmSent, setConfirmSent] = useState(false);

  const isSignup = authMode === "signup";
  const destination = safePath(next);
  const busy = loading || oauthLoading !== null;

  function toggleMode() {
    setAuthMode((m) => (m === "signin" ? "signup" : "signin"));
    setError(null);
    setConfirmSent(false);
  }

  async function handleOAuth(provider: OAuthProvider) {
    setError(null);
    setConfirmSent(false);
    setOauthLoading(provider);

    const supabase = createClient();
    // Supabase sends the user to the provider, the provider returns to
    // Supabase, and Supabase finally lands on this `redirectTo` with a `code`.
    // It must be on the allowlist under Authentication → URL Configuration.
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(destination)}`,
      },
    });

    // On success the browser is already navigating away, so the spinner is
    // deliberately left running rather than flashing off mid-redirect.
    if (oauthError) {
      setError(oauthError.message);
      setOauthLoading(null);
    }
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setConfirmSent(false);
    setLoading(true);

    const supabase = createClient();

    try {
      if (isSignup) {
        const { data, error: signUpError } = await supabase.auth.signUp({
          email,
          password,
        });
        if (signUpError) {
          setError(signUpError.message);
          return;
        }
        if (data.session) {
          router.push(destination);
          router.refresh();
          return;
        }
        // Email confirmation required.
        setConfirmSent(true);
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) {
          setError(signInError.message);
          return;
        }
        router.push(destination);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (confirmSent) {
    return (
      <div className="space-y-5 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded bg-mint-tint text-mint-ink">
          <CheckCircle2 className="h-6 w-6" aria-hidden />
        </div>
        <div>
          <h2 className="font-serif text-xl font-semibold text-ink">Check your email</h2>
          <p className="mt-2 text-sm text-ink-faint">
            We sent a confirmation link to <span className="font-medium text-ink-soft">{email}</span>.
            Click it to confirm your account, then sign in.
          </p>
        </div>
        <Button
          variant="secondary"
          className="w-full"
          onClick={() => {
            setConfirmSent(false);
            setAuthMode("signin");
          }}
        >
          Back to sign in
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="font-serif text-2xl font-semibold text-ink">
          {isSignup ? "Create your account" : "Welcome back"}
        </h1>
        <p className="mt-1 text-sm text-ink-faint">
          {isSignup
            ? "Start monitoring your brand across AI answers."
            : "Sign in to your Lettertrace workspace."}
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded border border-terracotta/30 bg-terracotta/10 px-3.5 py-3 text-sm text-terracotta-dark">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      )}

      <div className="space-y-3">
        {oauthProviders.map(({ id, label, Icon }) => (
          <Button
            key={id}
            type="button"
            variant="secondary"
            size="lg"
            className="w-full"
            disabled={busy}
            onClick={() => handleOAuth(id)}
          >
            {oauthLoading === id ? <Spinner /> : <Icon />}
            Continue with {label}
          </Button>
        ))}
      </div>

      <div className="relative">
        <div className="absolute inset-0 flex items-center" aria-hidden>
          <span className="w-full border-t border-ink/10" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-surface px-3 text-xs uppercase tracking-wide text-ink-faint">
            or
          </span>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete={isSignup ? "new-password" : "current-password"}
            required
            minLength={6}
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {loading ? (
            <>
              <Spinner />
              {isSignup ? "Creating account…" : "Signing in…"}
            </>
          ) : isSignup ? (
            "Create account"
          ) : (
            "Sign in"
          )}
        </Button>
      </form>

      <p className="text-center text-sm text-ink-faint">
        {isSignup ? "Already have an account?" : "Don't have an account?"}{" "}
        <button
          type="button"
          onClick={toggleMode}
          className="font-medium text-terracotta-dark transition hover:text-terracotta"
        >
          {isSignup ? "Sign in" : "Create one"}
        </button>
      </p>

      <p className="text-center text-xs text-ink-faint/80">
        New here? We create your workspace automatically.
      </p>
    </div>
  );
}
