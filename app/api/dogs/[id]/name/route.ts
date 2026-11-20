import { getDatabase } from '@/lib/db/index'
import { handleAdoptionRequest } from '@/lib/adoption/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleAdoptionRequest(request, 'rename', getDatabase, (await context.params).id)
}
