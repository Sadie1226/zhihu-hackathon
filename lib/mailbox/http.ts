import type { DatabaseSync } from 'node:sqlite'
import { readSessionId } from '../auth/session.ts'
import { TripError } from '../trips/service.ts'
import { markExchangeRead, readInbox, readOutbox, validMailboxId } from './service.ts'

type MailboxRequest = { action: 'inbox' | 'read'; id: string } | { action: 'outbox' }
const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie' }

function conflict(detail: string): never {
  throw new TripError('CONFLICT', detail)
}

function singleQuery(url: URL, name: string): string | null {
  // URLSearchParams silently replaces malformed percent-encoded sequences.
  try { decodeURIComponent(url.search) }
  catch { conflict('请求参数编码不正确') }
  const params = url.searchParams
  const values = params.getAll(name)
  if (values.length > 1 || [...params.keys()].some(key => key !== name)) {
    conflict('请求参数不符合信箱接口')
  }
  return values[0] ?? null
}

async function validateReadRequest(request: Request, url: URL) {
  if (url.search) conflict('已读请求不接受查询参数')
  const origin = request.headers.get('origin')
  const site = request.headers.get('sec-fetch-site')
  // Next may build request.url with its internal hostname.
  const host = request.headers.get('host')
  const expectedOrigin = host ? `${url.protocol}//${host}` : url.origin
  if (site === 'cross-site' || site === 'same-site' || (origin !== null && origin !== expectedOrigin)) {
    conflict('请求来源不匹配')
  }
  const contentType = request.headers.get('content-type')
  if (contentType?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    conflict('请求需要 JSON 内容')
  }
  const body: unknown = await request.json().catch(() => conflict('JSON 内容格式不正确'))
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0) {
    conflict('已读请求需要空 JSON 对象')
  }
}

export async function handleMailboxRequest(
  request: Request, target: MailboxRequest, getDatabase: () => DatabaseSync,
): Promise<Response> {
  try {
    const sessionId = readSessionId(request)
    if (!sessionId || (target.action !== 'outbox' && !validMailboxId(target.id))) {
      throw new TripError('NOT_FOUND', '这条记录不在这里')
    }
    const url = new URL(request.url)
    switch (target.action) {
      case 'inbox': {
        const filter = singleQuery(url, 'filter') ?? 'all'
        if (filter !== 'onTheWay' && filter !== 'arrived' && filter !== 'all') {
          return conflict('filter 应为 onTheWay、arrived 或 all')
        }
        return Response.json(readInbox(getDatabase(), target.id, sessionId, filter), { headers })
      }
      case 'outbox': {
        const fromDog = singleQuery(url, 'from_dog')
        if (!validMailboxId(fromDog)) return conflict('from_dog 应为一个非空狗 ID')
        return Response.json(readOutbox(getDatabase(), fromDog, sessionId), { headers })
      }
      case 'read':
        await validateReadRequest(request, url)
        return Response.json({ exchange: markExchangeRead(getDatabase(), target.id, sessionId) }, { headers })
    }
  } catch (error) {
    if (error instanceof TripError) {
      return Response.json({ code: error.code, detail: error.message, retriable: false },
        { status: error.code === 'NOT_FOUND' ? 404 : 409, headers })
    }
    return Response.json({ code: 'NETWORK', detail: '这次没连上，可以再试一次', retriable: true },
      { status: 503, headers })
  }
}
