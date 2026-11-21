// 目标位置：app/(b)/api/replies/route.ts
// POST /api/replies：写入前查来源归属与交换送达；幂等重放返回库中真实记录。
import { statSync } from 'node:fs'
import path from 'node:path'
import { getDatabase } from '@/lib/db/index'
import { readSessionId } from '@/lib/auth/session'
import { writeReply } from '@/lib/replies/idempotency'
import { parseOwnPhotoUrl, uploadDir } from '../../b6-photo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Body = { exchangeId?: string; invitationId?: string; text?: string; photoUrl?: string }
type Source = { kind: 'exchange' | 'invitation'; id: string }

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}
const conflict = (detail: string) => json({ code: 'CONFLICT', detail }, 409)
const missing = (detail: string) => json({ code: 'NOT_FOUND', detail }, 404)

function sourceProblem(
  db: ReturnType<typeof getDatabase>,
  source: Source,
  sessionId: string,
): Response | null {
  if (source.kind === 'invitation') {
    const found = db.prepare(
      `SELECT 1 FROM invitation i JOIN dog d ON d.id = i.dog_id
       WHERE i.id = ? AND d.session_id = ?`,
    ).get(source.id, sessionId)
    return found ? null : missing('来源不存在或不属于当前会话')
  }
  const exchange = db.prepare(
    `SELECT e.delivered_at AS deliveredAt FROM exchange e JOIN dog d ON d.id = e.to_dog
     WHERE e.id = ? AND d.session_id = ?`,
  ).get(source.id, sessionId) as { deliveredAt: string | null } | undefined
  if (!exchange) return missing('来源不存在或不属于当前会话')
  if (!exchange.deliveredAt) return conflict('这条交换还没送达')
  return null
}

function uploadedFileExists(name: string): boolean {
  // 必须和上传路由用同一个目录来源，否则「写 A 目录、查 B 目录」会把本人上传判成 missing。
  try {
    return statSync(path.join(uploadDir(), name)).isFile()
  } catch {
    return false
  }
}

export async function POST(request: Request) {
  const sessionId = readSessionId(request)
  if (!sessionId) return json({ code: 'UNAUTHORIZED', detail: '没有有效会话' }, 401)

  const value: unknown = await request.json().catch(() => null)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return conflict('请求体不是合法 JSON 对象')
  }
  const body = value as Body
  const allowed = ['exchangeId', 'invitationId', 'text', 'photoUrl']
  if (Object.keys(body).some(key => !allowed.includes(key))) {
    return conflict('请求包含未定义字段')
  }

  const hasExchange = typeof body.exchangeId === 'string' && body.exchangeId.length > 0
  const hasInvitation = typeof body.invitationId === 'string' && body.invitationId.length > 0
  if (hasExchange === hasInvitation) {
    return conflict('exchangeId 与 invitationId 必须恰好给一个')
  }
  const source: Source = hasExchange
    ? { kind: 'exchange', id: body.exchangeId as string }
    : { kind: 'invitation', id: body.invitationId as string }

  const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim() : null
  if (text && Array.from(text).length > 200) return conflict('文字需在 1 到 200 字')

  let photoUrl: string | null = null
  if (typeof body.photoUrl === 'string' && body.photoUrl.length > 0) {
    const verdict = parseOwnPhotoUrl(body.photoUrl, sessionId, uploadedFileExists)
    if (!verdict.ok) {
      const detail = verdict.reason === 'owner' ? '图片不属于当前会话'
        : verdict.reason === 'missing' ? '图片不存在或尚未上传完成' : '图片地址不合法'
      return conflict(detail)
    }
    photoUrl = verdict.name
  }
  if (!text && !photoUrl) return conflict('文字和图片至少给一个')

  const db = getDatabase()
  const problem = sourceProblem(db, source, sessionId)
  if (problem) return problem

  // 幂等写入核心抽到 lib/replies/idempotency，便于直接单测；行为与内联版严格等价：
  //   首次 200 + 真实 reply；同一来源重复 200 + 原 reply + duplicate；库里 1 行。
  const result = writeReply(db, { source, text, photoUrl })
  if (result.kind === 'failed') return conflict('回应未能写入')
  if (result.kind === 'duplicate') return json({ reply: result.reply, duplicate: true })
  return json({ reply: result.reply })
}
