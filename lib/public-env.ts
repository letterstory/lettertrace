/**
 * Public browser configuration, delivered at request time rather than baked
 * into the bundle at build time.
 *
 * WHY THIS EXISTS. Next inlines `NEXT_PUBLIC_*` into the client bundle when the
 * app is built. That is fine on Vercel, where we build with the right values —
 * but it makes a prebuilt container image unusable by anyone else: the browser
 * would carry whatever Supabase project WE built against and silently ignore
 * the `-e NEXT_PUBLIC_SUPABASE_URL=...` the operator passed to `docker run`.
 * Silently is the problem. Everything would look configured and nothing would
 * work.
 *
 * So the server reads these at runtime and hands them to the browser in a small
 * inline script, the same way the theme flash-guard already does.
 *
 * NOTHING SECRET GOES THROUGH HERE. The anon key is designed to sit in a
 * browser — it is the key RLS policies are written against. The service-role
 * key is server-only and must never appear in this object.
 *
 * ONE INVARIANT: any page whose client components call `createClient()` must be
 * dynamically rendered, or the script is baked at build time and we are back
 * where we started. Every such page reads cookies for auth today, which makes
 * it dynamic automatically — but if you add a static page with a Supabase
 * browser client on it, that page needs to opt into dynamic rendering.
 */

export interface PublicEnv {
	supabaseUrl: string;
	supabaseAnonKey: string;
}

/** The window property the script writes and the browser client reads. */
export const PUBLIC_ENV_GLOBAL = "__LETTERTRACE_PUBLIC_ENV__";

/** Read at request time on the server, where `process.env` is still live. */
export function serverPublicEnv(): PublicEnv {
	return {
		supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
		supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
	};
}

/**
 * The inline script, as source.
 *
 * `<` is escaped because a JSON string containing `</script>` would end the
 * element early — the standard defence, and the only escaping this needs given
 * every value is a URL or a key.
 */
export function publicEnvScript(env: PublicEnv = serverPublicEnv()): string {
	const json = JSON.stringify(env).replace(/</g, "\\u003c");
	return `window.${PUBLIC_ENV_GLOBAL}=${json};`;
}
