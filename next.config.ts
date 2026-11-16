import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  poweredByHeader: false,
  outputFileTracingIncludes: {
    '/api/health': ['./contracts/schema.sql'],
  },
}

export default nextConfig
