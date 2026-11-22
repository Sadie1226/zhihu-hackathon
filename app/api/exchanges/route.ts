import { getDatabase } from '@/lib/db/index'
import { handleMailboxRequest } from '@/lib/mailbox/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(request: Request) {
  return handleMailboxRequest(request, { action: 'outbox' }, getDatabase)
}
