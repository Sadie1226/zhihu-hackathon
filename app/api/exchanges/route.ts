import { getDatabase } from '@/lib/db/index'
import { handleMailboxRequest } from '@/lib/mailbox/http'
import { handleExchangeSend } from '@/lib/social/send-endpoint'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(request: Request) {
  return handleMailboxRequest(request, { action: 'outbox' }, getDatabase)
}

/**
 * 契约 `contracts/api.md` §7 的寄出入口（d6）。逻辑全在 `lib/social/send-endpoint.ts`，
 * 这里只转调 —— 读接口（GET）仍是 c 的实现，未改动。
 */
export function POST(request: Request) {
  return handleExchangeSend(request, getDatabase)
}
