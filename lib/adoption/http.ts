import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import {
  clearSessionCookie,
  developmentEnabled,
  resolveAuthContext,
  revokeSession,
  startDevelopmentSession,
} from '../auth/session.ts'
import {
  AdoptionError,
  createDevelopmentDog,
  generateDevelopment,
  mockProfile,
  ownedDog,
  parseDraft,
  renameDevelopmentDog,
} from './development.ts'

const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie' }
type Action =
  | 'session'
  | 'login'
  | 'logout'
  | 'profile'
  | 'generate'
  | 'create'
  | 'dog'
  | 'rename'

export async function handleAdoptionRequest(
  request: Request,
  action: Action,
  getDatabase: () => DatabaseSync,
  id?: string,
): Promise<Response> {
  const json = (
    value: unknown,
    status = 200,
    extra: Record<string, string> = {},
  ) => Response.json(value, { status, headers: { ...headers, ...extra } })
  try {
    const enabled = developmentEnabled()
    if (!enabled && ['login', 'profile', 'generate', 'create'].includes(action))
      return json(
        { code: 'NOT_FOUND', detail: '身份接入尚未开放', retriable: false },
        404,
      )
    // Next development normalizes request.url to localhost even for 127.0.0.1.
    // Host is the actual browser target; never accept a forwarded host as an allowlist.
    const target = new URL(request.url)
    const expectedOrigin = request.headers.has('host')
      ? `${target.protocol}//${request.headers.get('host')}`
      : target.origin
    if (
      request.method !== 'GET' &&
      (request.headers.get('sec-fetch-site') === 'cross-site' ||
        (request.headers.has('origin') &&
          request.headers.get('origin') !== expectedOrigin))
    ) {
      throw new AdoptionError('CONFLICT', '请求来源不匹配')
    }
    const db = getDatabase()
    if (action === 'logout') {
      revokeSession(request, db)
      return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() })
    }
    if (action === 'login') {
      const setCookie = startDevelopmentSession(request, db)
      return json(
        { ok: true, provider: 'development' },
        200,
        setCookie ? { 'Set-Cookie': setCookie } : {},
      )
    }
    const auth = resolveAuthContext(request, db)
    if (action === 'session')
      return json({
        provider: auth?.namespace ?? (enabled ? 'development' : 'unavailable'),
        authenticated: !!auth,
        draftScope: auth
          ? createHash('sha256')
              .update(`a5-ui-draft-v1:${auth.ownerId}`)
              .digest('hex')
          : null,
        dog: auth ? ownedDog(db, auth.ownerId) : null,
      })
    if (!auth)
      throw new AdoptionError('NOT_FOUND', '身份已失效，请重新进入')
    if (action === 'profile') return json(mockProfile)
    if (action === 'dog') {
      const dog = ownedDog(db, auth.ownerId, id)
      if (!dog) throw new AdoptionError('NOT_FOUND', '这只伙伴不在这里')
      return json({ dog })
    }
    if (
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      throw new AdoptionError('CONFLICT', '请求需要 JSON 内容')
    const body: unknown = await request.json().catch(() => {
      throw new AdoptionError('CONFLICT', '输入格式不正确')
    })
    if (!resolveAuthContext(request, db))
      throw new AdoptionError('NOT_FOUND', '身份已失效，请重新进入')
    if (action === 'generate')
      return json(generateDevelopment(parseDraft(body)))
    if (action === 'create')
      return json({ dog: createDevelopmentDog(db, auth.ownerId, body) })
    if (action === 'rename') {
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).join(',') !== 'name'
      )
        throw new AdoptionError('CONFLICT', '改名只接收名字')
      return json({
        dog: renameDevelopmentDog(
          db,
          auth.ownerId,
          id!,
          (body as { name: unknown }).name,
        ),
      })
    }
    throw new AdoptionError('NOT_FOUND', '这个入口尚未开放')
  } catch (error) {
    if (error instanceof AdoptionError)
      return json(
        {
          code: error.code,
          detail: error.message,
          publicMessage: error.message,
          retriable: false,
        },
        error.code === 'NOT_FOUND' ? 404 : 409,
      )
    return json(
      {
        code: 'NETWORK',
        detail: '这次没读出来，可以再试一次',
        retriable: true,
      },
      503,
    )
  }
}
