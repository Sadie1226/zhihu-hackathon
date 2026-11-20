// 目标位置：app/(b)/api/dogs/[id]/invitations/route.ts
// GET /api/dogs/:id/invitations —— 归来区复用邀请正文的只读来源，状态读 C 的视图。
import { getDatabase } from '@/lib/db/index'
import { readSessionId } from '@/lib/auth/session'
import type { InvitationState, InvitationView } from '@/contracts/types'

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

function fail(status: number, code: string, detail: string) {
  return Response.json({ code, detail }, { status, headers })
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
    return fail(503, 'NETWORK', '这次没连上，可以再试一次')
  }
}
