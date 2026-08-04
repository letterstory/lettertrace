/**
 * Is this deployment configured, or only running?
 *
 * Most launch-night failures are not code failures. They are a variable that
 * was never set, or was set under a name one character off — which produces a
 * deployment that boots, serves pages, and silently cannot do the one thing it
 * exists for. Nothing in the app surfaces that; the feature just quietly does
 * nothing, and the first report comes from a user.
 *
 * PRESENCE ONLY. This reports whether a variable is set, never any part of its
 * value — not a prefix, not a length, not a masked tail. A page behind an
 * allowlist is still a page, and a secret confirmed four characters at a time
 * is still a leaked secret.
 */

export type CheckState = "ok" | "missing" | "off";

export interface ConfigCheck {
  key: string;
  label: string;
  state: CheckState;
  /** What actually breaks when this is missing — the reason it is on the list. */
  impact: string;
  required: boolean;
}

const isSet = (v: string | undefined): boolean => typeof v === "string" && v.trim().length > 0;

export function configChecks(env: NodeJS.ProcessEnv = process.env): ConfigCheck[] {
  const check = (
    key: string,
    label: string,
    impact: string,
    required: boolean,
  ): ConfigCheck => ({
    key,
    label,
    state: isSet(env[key]) ? "ok" : required ? "missing" : "off",
    impact,
    required,
  });

  return [
    check("NEXT_PUBLIC_SUPABASE_URL", "Supabase URL", "Nothing works without it", true),
    check("NEXT_PUBLIC_SUPABASE_ANON_KEY", "Supabase anon key", "Nobody can sign in", true),
    check(
      "SUPABASE_SERVICE_ROLE_KEY",
      "Service role key",
      "Background runs and this dashboard both fail",
      true,
    ),
    check(
      "ENCRYPTION_KEY",
      "Encryption key",
      "Provider keys cannot be saved or read back",
      true,
    ),
    check("NEXT_PUBLIC_SITE_URL", "Site URL", "OAuth redirects and emails point at the wrong host", true),
    check(
      "TRIAL_ANTHROPIC_API_KEY",
      "Trial key",
      "New users cannot run anything before adding their own key",
      true,
    ),
    check("RESEND_API_KEY", "Resend key", "Signup alerts are not sent", false),
    check("ADMIN_ALERT_EMAIL", "Alert recipient", "Signup alerts have nowhere to go", false),
    check("CRON_SECRET", "Cron secret", "Scheduled runs are unauthenticated or off", false),
    check("ADMIN_EMAILS", "Operator allowlist", "This dashboard is unreachable", false),
    check("OPS_TELEMETRY", "Telemetry", "Errors outside runs are not recorded", false),
  ];
}

/** Required things that are missing — the list worth interrupting someone for. */
export function configProblems(checks: ConfigCheck[]): ConfigCheck[] {
  return checks.filter((c) => c.required && c.state === "missing");
}
