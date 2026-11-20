import { getDatabase } from '@/lib/db/index'
import { handleAdoptionRequest } from '@/lib/adoption/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(request: Request) {
  return handleAdoptionRequest(request, 'session', getDatabase)
}
