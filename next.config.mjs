/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    // Lint is run separately in CI; don't fail production builds on lint.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
