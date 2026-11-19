import { getDatabase } from '@/lib/db/index'
import { handleAdoptionRequest } from '@/lib/adoption/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleAdoptionRequest(request, 'dog', getDatabase, (await context.params).id)
}
