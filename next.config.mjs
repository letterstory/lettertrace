/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emits .next/standalone — a self-contained server with only the node_modules
  // it actually needs. This is what keeps the container image small enough to
  // be worth publishing. Vercel ignores it, so the hosted deploy is unaffected.
  output: "standalone",
  // Next 14 only loads instrumentation.ts behind this flag (it became default
  // in 15). Without it the OTel SDK is never started and nothing exports.
  experimental: {
    instrumentationHook: true,
  },
  eslint: {
    // Lint is run separately in CI; don't fail production builds on lint.
    ignoreDuringBuilds: true,
  },
  // Refuse to be framed anywhere. This matters most for the OAuth consent and
  // device-activation screens: a click on "Approve" inside an invisible iframe
  // would otherwise let an attacker's page harvest a grant (clickjacking).
  // frame-ancestors governs who may embed US; it does not restrict iframes we
  // embed (e.g. the BYOK explainer video), so nothing else is affected.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;
