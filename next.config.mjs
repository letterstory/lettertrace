/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
