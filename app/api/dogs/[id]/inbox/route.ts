import { getDatabase } from '@/lib/db/index'
import { handleMailboxRequest } from '@/lib/mailbox/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleMailboxRequest(request, { action: 'inbox', id: (await params).id }, getDatabase)
}
