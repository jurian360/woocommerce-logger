/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Mongoose is a native/CJS-heavy package: keep it out of the bundler and let
  // it be required at runtime from node_modules on the serverless function.
  serverExternalPackages: ['mongoose'],

  // The audit log must never be served from a CDN cache.
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store, max-age=0' }],
      },
    ];
  },
};

export default nextConfig;
