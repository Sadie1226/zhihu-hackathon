import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  poweredByHeader: false,
  outputFileTracingIncludes: {
    '/api/**': ['./contracts/schema.sql'],
  },
}

export default nextConfig
