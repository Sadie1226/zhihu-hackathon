import { getDatabase } from '@/lib/db/index'
import { handleTripRequest } from '@/lib/trips/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleTripRequest(request, 'get', (await context.params).id, getDatabase)
}
