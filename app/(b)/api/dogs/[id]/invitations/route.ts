// GET/POST /api/dogs/:id/invitations —— GET 沿用 main v7 的 tripId/Find 过滤（A 的修复），
// POST 是 B6 的邀请生成（基于 C 的 v_invitation_state 视图，不写 status/expires_at）。
import { getDatabase } from '@/lib/db/index'
import { readSessionId } from '@/lib/auth/session'
import { TripError } from '@/lib/trips/service'
import type { InvitationState, InvitationView } from '@/contracts/types'
import { createInvitationStore, type InvitationInput } from '../../../../b6-invitations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Context = { params: Promise<{ id: string }> }
type InvitationRow = {
  invitation_id: string
  dog_id: string
  text: string
  based_on_find_id: string | null
  created_at: string
  state: InvitationState
  reply_id: string | null
  gone_alone_trip_id: string | null
}

const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie' }

function fail(status: number, code: string, detail: string, retriable = false) {
  return Response.json({ code, detail, retriable }, { status, headers })
}

function dto(row: InvitationRow): InvitationView {
  return {
    id: row.invitation_id,
    dogId: row.dog_id,
    text: row.text,
    basedOnFindId: row.based_on_find_id,
    createdAt: row.created_at,
    state: row.state,
    replyId: row.reply_id,
    goneAloneTripId: row.gone_alone_trip_id,
  }
}

export async function GET(request: Request, context: Context) {
  try {
    const sessionId = readSessionId(request)
    if (!sessionId) return fail(404, 'NOT_FOUND', '这条记录不在这里')
    const dogId = (await context.params).id
    const db = getDatabase()
    const owned = db.prepare('SELECT 1 FROM dog WHERE id = ? AND session_id = ?').get(dogId, sessionId)
    if (!owned) return fail(404, 'NOT_FOUND', '这条记录不在这里')
    const params = new URL(request.url).searchParams
    if ([...params.keys()].some(key => !['state', 'tripId'].includes(key)) || params.getAll('tripId').length > 1)
      return fail(409, 'CONFLICT', '读取条件不正确')
    const tripId = params.get('tripId')
    if (tripId !== null && (!tripId || !db.prepare('SELECT 1 FROM trip WHERE id=? AND dog_id=?').get(tripId, dogId)))
      return fail(404, 'NOT_FOUND', '这条记录不在这里')

    const rows = db.prepare(
      `SELECT v.invitation_id, v.dog_id, v.text, i.based_on_find_id, v.created_at,
              v.state, v.reply_id, v.gone_alone_trip_id
       FROM v_invitation_state v JOIN invitation i ON i.id = v.invitation_id
       WHERE v.dog_id = ? AND (? IS NULL OR EXISTS (
         SELECT 1 FROM find f WHERE f.id=i.based_on_find_id AND f.trip_id=?
       ))
       ORDER BY v.created_at DESC, v.invitation_id DESC`,
    ).all(dogId, tripId, tripId) as InvitationRow[]
    const invitations: InvitationView[] = rows.map(dto)
    return Response.json({ invitations }, { headers })
  } catch {
    return fail(503, 'NETWORK', '这次没连上，可以再试一次', true)
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const sessionId = readSessionId(request)
    if (!sessionId) return fail(404, 'NOT_FOUND', '这条记录不在这里')
    const dogId = (await context.params).id
    const body = await request.json().catch(() => null) as InvitationInput | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail(409, 'CONFLICT', '邀请请求需要是一个对象')
    }
    const result = createInvitationStore(getDatabase()).create(dogId, sessionId, body)
    return Response.json(result, { headers })
  } catch (error) {
    if (error instanceof TripError) {
      return fail(error.code === 'NOT_FOUND' ? 404 : 409, error.code, error.message)
    }
    return fail(503, 'NETWORK', '这次没连上，可以再试一次', true)
  }
}
