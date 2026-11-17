import type { DatabaseSync } from 'node:sqlite'
import type { TripTrigger } from '../../contracts/types.ts'
import { readSessionId } from '../auth/session.ts'
import { createTripService, isTerminal, TripError } from './service.ts'

type Action = 'create' | 'start' | 'finish' | 'get' | 'list'
const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie' }
const invalid = (detail: string): never => { throw new TripError('CONFLICT', detail) }

export async function handleTripRequest(request: Request, action: Action, id: string,
  getDatabase: () => DatabaseSync): Promise<Response> {
  try {
    const session = readSessionId(request)
    if (!session) throw new TripError('NOT_FOUND', '这条记录不在这里')
    const url = new URL(request.url)
    const query = [...url.searchParams.keys()]
    if (query.some(key => action !== 'list' || key !== 'limit') || url.searchParams.getAll('limit').length > 1) {
      invalid('请求参数不符合出行接口')
    }
    let body: Record<string, unknown> = {}
    if (action === 'create' || action === 'start' || action === 'finish') {
      if (request.headers.get('sec-fetch-site') === 'cross-site' ||
        (request.headers.has('origin') && request.headers.get('origin') !== url.origin)) invalid('请求来源不匹配')
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        invalid('请求需要 JSON 内容')
      }
      const value: unknown = await request.json().catch(() => invalid('JSON 内容格式不正确'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('请求需要 JSON 对象')
      body = value as Record<string, unknown>
      const allowed = action === 'create' ? ['trigger'] : action === 'finish' ? ['status'] : []
      if (Object.keys(body).some(key => !allowed.includes(key))) invalid('请求包含未定义字段')
    }
    const service = createTripService(getDatabase())
    let result: unknown
    switch (action) {
      case 'get': result = { trip: service.get(id, session) }; break
      case 'list': {
        const raw = url.searchParams.get('limit') ?? '10'
        if (!/^[1-9]\d{0,2}$/.test(raw)) invalid('limit 应为 1 到 100 的整数')
        result = { trips: service.list(id, session, Number(raw)) }; break
      }
      case 'create':
        if (typeof body.trigger !== 'string' || !['auto', 'wish', 'friend'].includes(body.trigger)) invalid('trigger 不符合契约')
        result = { trip: service.create(id, session, body.trigger as TripTrigger) }; break
      case 'start': result = service.start(id, session); break
      case 'finish': {
        const status = body.status
        if (typeof status !== 'string' || !isTerminal(status)) return invalid('status 不符合契约')
        result = service.finish(id, session, status); break
      }
    }
    return Response.json(result, { headers })
  } catch (error) {
    if (error instanceof TripError) return Response.json({ code: error.code, detail: error.message, retriable: false },
      { status: error.code === 'NOT_FOUND' ? 404 : 409, headers })
    return Response.json({ code: 'NETWORK', detail: '这次没连上，可以再试一次', retriable: true }, { status: 503, headers })
  }
}
