/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  async rewrites() {
    return [
      {
        source: '/app/:path',
        destination: 'http://localhost:3001/:path',
      }
    ];
  },
}

module.exports = nextConfig
