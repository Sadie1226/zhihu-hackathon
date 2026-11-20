import { getDatabase } from '@/lib/db/index'
import { handleFindsRequest } from '@/lib/trips/finds'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleFindsRequest(request, (await context.params).id, getDatabase)
}
