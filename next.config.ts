import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  outputFileTracingIncludes: {
    '/api/**': ['./contracts/schema.sql'],
  },
}

export default nextConfig
