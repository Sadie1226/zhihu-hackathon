import type { DatabaseSync } from 'node:sqlite'
import type { Message } from '../../contracts/types.ts'
import { readSessionId } from '../auth/session.ts'
import { TripError } from '../trips/service.ts'

const missing = (): never => { throw new TripError('NOT_FOUND', '这条记录不在这里') }
const validId = (value: unknown): value is string => typeof value === 'string' && !!value && value === value.trim() &&
  ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)

/** One SELECT provides a consistent ownership/message/reference snapshot. No write,
 * migration, generation, state transition, or call to finish is performed here.
 * Latest-record selection is deterministic, pending B/A policy confirmation.
 */
export function readTripMessage(db: DatabaseSync, tripId: string, sessionId: string): Message | null {
  if (!validId(tripId) || !validId(sessionId)) return missing()
  const row = db.prepare(`SELECT m.rowid AS messageRowid, m.id, m.trip_id AS tripId, m.text,
    m.mentions_find_id AS mentionsFindId, m.created_at AS createdAt, f.trip_id AS referenceTripId
    FROM trip t JOIN dog d ON d.id=t.dog_id
    LEFT JOIN message m ON m.rowid=(SELECT candidate.rowid FROM message candidate
      WHERE candidate.trip_id=t.id ORDER BY julianday(candidate.created_at) DESC, candidate.id DESC LIMIT 1)
    LEFT JOIN find f ON f.id=m.mentions_find_id
    WHERE t.id=? AND d.session_id=?`).get(tripId, sessionId)
  if (!row) return missing()
  if (row.messageRowid === null) return null
  // Do not emit foreign Find IDs or silently fall back to an older message.
  if (row.mentionsFindId !== null && row.referenceTripId !== tripId) throw new Error('Invalid Message reference')
  if (!validId(row.id) || typeof row.text !== 'string' || typeof row.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(row.createdAt))) throw new Error('Invalid Message record')
  return { id: row.id, tripId, text: row.text,
    mentionsFindId: row.mentionsFindId as string | null, createdAt: row.createdAt }
}

/** Public GET boundary. Cookie-derived session only; no session/owner overrides. */
export function handleMessageReadRequest(request: Request, tripId: string, getDatabase: () => DatabaseSync): Response {
  const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie' }
  try {
    const sessionId = readSessionId(request)
    if (request.method !== 'GET' || !sessionId || !validId(tripId) || new URL(request.url).search) return missing()
    return Response.json({ message: readTripMessage(getDatabase(), tripId, sessionId) }, { headers })
  } catch (error) {
    if (error instanceof TripError && error.code === 'NOT_FOUND') {
      return Response.json({ code: 'NOT_FOUND', detail: error.message, retriable: false }, { status: 404, headers })
    }
    return Response.json({ code: 'NETWORK', detail: '这次没连上，可以再试一次', retriable: true }, { status: 503, headers })
  }
}
