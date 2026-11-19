// 目标位置：app/(b)/api/replies/route.ts
// route group 不改变对外 URL，仍是 /api/replies。契约 api.md:182 标题「回应（b 实现，唯一）」。
import { statSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getDatabase } from '@/lib/db/index'
import { readSessionId, parseOwnPhotoUrl } from '../../b6-photo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

type Body = { exchangeId?: string; invitationId?: string; text?: string; photoUrl?: string }

export async function POST(request: Request) {
  const sessionId = readSessionId(request)
  if (!sessionId) return json({ code: 'UNAUTHORIZED', detail: '没有有效会话' }, 401)

  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return json({ code: 'CONFLICT', detail: '请求体不是合法 JSON' }, 409)
  }

  const hasExchange = typeof body.exchangeId === 'string' && body.exchangeId.length > 0
  const hasInvitation = typeof body.invitationId === 'string' && body.invitationId.length > 0
  if (hasExchange === hasInvitation) {
    return json({ code: 'CONFLICT', detail: 'exchangeId 与 invitationId 必须恰好给一个' }, 409)
  }

  const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim() : null
  if (text && (Array.from(text).length < 1 || Array.from(text).length > 200)) {
    return json({ code: 'CONFLICT', detail: '文字需在 1–200 字' }, 409)
  }

  // photoUrl 收口：三段判断，挡住客户端自报的假地址。
  let photoUrl: string | null = null
  if (body.photoUrl !== undefined && body.photoUrl !== null && body.photoUrl !== '') {
    const exists = (name: string) => {
      try {
        return statSync(path.join(process.cwd(), 'public', 'uploads', name)).isFile()
      } catch {
        return false
      }
    }
    const verdict = parseOwnPhotoUrl(body.photoUrl, sessionId, exists)
    if (!verdict.ok) {
      const msg = verdict.reason === 'owner' ? '图片不属于当前会话'
        : verdict.reason === 'missing' ? '图片不存在或尚未上传完成' : '图片地址不合法'
      return json({ code: 'CONFLICT', detail: msg }, 409)
    }
    photoUrl = verdict.name
  }

  if (!text && !photoUrl) {
    return json({ code: 'CONFLICT', detail: '文字和图片至少给一个' }, 409)
  }

  const db = getDatabase()
  const id = `r_${randomUUID().replace(/-/g, '')}`
  const createdAt = new Date().toISOString()
  try {
    db.prepare(
      `INSERT INTO reply (id, exchange_id, invitation_id, text, photo_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, hasExchange ? body.exchangeId! : null, hasInvitation ? body.invitationId! : null,
      text, photoUrl, createdAt)
  } catch (err) {
    // 唯一索引冲突＝重复提交，前端当成功（幂等）。
    const code = (err as { code?: string })?.code ?? ''
    if (code.includes('CONSTRAINT') || String(err).includes('UNIQUE')) {
      return json({ reply: { id, exchangeId: body.exchangeId ?? null, invitationId: body.invitationId ?? null,
        text, photoUrl, kind: photoUrl ? (text ? 'both' : 'photo') : 'text', createdAt }, duplicate: true })
    }
    return json({ code: 'CONFLICT', detail: '回应未能写入' }, 409)
  }

  return json({ reply: { id, exchangeId: body.exchangeId ?? null, invitationId: body.invitationId ?? null,
    text, photoUrl, kind: photoUrl ? (text ? 'both' : 'photo') : 'text', createdAt } })
}
