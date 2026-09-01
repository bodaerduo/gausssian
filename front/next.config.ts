import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: '/api/health', destination: 'http://127.0.0.1:4178/health' },
      { source: '/api/:path*', destination: 'http://127.0.0.1:4178/api/:path*' },
    ];
  },
};

export default nextConfig;
