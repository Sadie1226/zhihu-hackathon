import { getDatabase } from '@/lib/db/index'
import { handleAdoptionRequest } from '@/lib/adoption/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(request: Request) {
  return handleAdoptionRequest(request, 'generate', getDatabase)
}
