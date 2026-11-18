import { getDatabase } from '@/lib/db/index'
import { handleTripRequest } from '@/lib/trips/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleTripRequest(request, 'start', (await context.params).id, getDatabase)
}
