import type { NextConfig } from 'next'
import { config } from 'dotenv'
import path from 'node:path'

// Load .env.local from the monorepo root (one level up)
config({ path: path.resolve(__dirname, '..', '.env.local') })

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3', 'dockerode'],
}

export default nextConfig
