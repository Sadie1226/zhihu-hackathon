import { getDatabase } from '@/lib/db/index'
import { handleTripRequest } from '@/lib/trips/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, context: Context) {
  return handleTripRequest(request, 'list', (await context.params).id, getDatabase)
}
export async function POST(request: Request, context: Context) {
  return handleTripRequest(request, 'create', (await context.params).id, getDatabase)
}
