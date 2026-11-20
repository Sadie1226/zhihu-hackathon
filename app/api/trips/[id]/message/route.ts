import { getDatabase } from '@/lib/db/index'
import { handleMessageReadRequest } from '@/lib/messages/read'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleMessageReadRequest(request, (await context.params).id, getDatabase)
}
