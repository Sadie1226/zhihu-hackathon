import { getDatabase } from '@/lib/db'
import { databaseHealth } from '@/lib/db/health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(): Response {
  return databaseHealth(getDatabase)
}
