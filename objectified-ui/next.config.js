/** @type {import('next').NextConfig} */
const REWRITE_LIST = [
  {
    source: '/app/:path',
    destination: 'http://localhost:3001/:path',
  }
];

const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  async rewrites() {
    return REWRITE_LIST;
  },
}

for(const entry of REWRITE_LIST) {
  console.log(`Proxy forwarding: ${entry.source} -> ${entry.destination}`);
}

module.exports = nextConfig
