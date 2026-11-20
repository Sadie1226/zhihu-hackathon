import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Find } from '../../contracts/types.ts'
import { readSessionId } from '../auth/session.ts'
import { TripError } from './service.ts'
import { proofTripId, verifiedSearchInput } from './search-proof.ts'
import type { SearchProof } from './search-proof.ts'

export type FindInput = Omit<Find, 'id' | 'createdAt'> & {
  /** Internal stable source identity for scene/moment, not a UI-supplied title. */
  sourceKey?: string
}
const missing = (): never => { throw new TripError('NOT_FOUND', '这条记录不在这里') }
const conflict = (): never => { throw new TripError('CONFLICT', '发现内容或来源不符合存储要求') }
const projection = `f.id, f.trip_id AS tripId, f.kind, f.title, f.excerpt,
  f.source_url AS sourceUrl, f.source_mode AS sourceMode, f.authority_level AS authorityLevel,
  f.vote_up_count AS voteUpCount, f.asset_path AS assetPath, f.created_at AS createdAt`

function transaction<T>(db: DatabaseSync, write: boolean, action: () => T): T {
  db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
  try {
    const result = action()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
}

function sourceUrl(value: unknown, zhihu: boolean): string {
  if (typeof value !== 'string' || /\s|\\/.test(value)) return conflict()
  let url: URL
  try { url = new URL(value) } catch { return conflict() }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return conflict()
  if (zhihu) {
    if (['www.zhihu.com', 'zhihu.com'].includes(url.hostname) &&
        /^\/question\/[1-9][0-9]*(?:\/answer\/[1-9][0-9]*)?\/?$/.test(url.pathname)) {
      url.hostname = 'www.zhihu.com'
    } else if (!(url.hostname === 'zhuanlan.zhihu.com' && /^\/p\/[1-9][0-9]*\/?$/.test(url.pathname))) return conflict()
    url.pathname = url.pathname.replace(/\/$/, '')
    url.search = ''; url.hash = ''
  }
  return url.href
}

function normalized(input: FindInput, verified = false): { data: Omit<Find, 'id' | 'createdAt'>; identity: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['tripId', 'kind', 'title', 'excerpt', 'sourceUrl', 'sourceMode',
        'authorityLevel', 'voteUpCount', 'assetPath', 'sourceKey'].includes(key))) return conflict()
  if (!['zhihu', 'scene', 'moment'].includes(input.kind) || typeof input.title !== 'string' || !input.title.trim() ||
      !(input.excerpt === null || typeof input.excerpt === 'string')) return conflict()
  if (input.authorityLevel !== null && ![1, 2, 3, 4].includes(input.authorityLevel)) return conflict()
  if (input.voteUpCount !== null && (!Number.isSafeInteger(input.voteUpCount) || input.voteUpCount < 0)) return conflict()
  if (input.assetPath !== null && (typeof input.assetPath !== 'string' || !/^\/(?!\/)/.test(input.assetPath) ||
      /[\\?#%\s]/.test(input.assetPath) || input.assetPath.split('/').some(part => part === '.' || part === '..'))) return conflict()
  // Ordinary writes remain fixture-only. Only opaque successful C5 proofs authorize live.
  if (input.kind === 'zhihu' ? input.sourceMode !== (verified ? 'live' : 'fixture') : input.sourceMode !== null) return conflict()
  const url = input.sourceUrl === null && input.kind !== 'zhihu' ? null : sourceUrl(input.sourceUrl, input.kind === 'zhihu')
  const key = input.sourceKey
  if (input.kind !== 'zhihu' && (!validId(key) || key.length > 200)) return conflict()
  if (input.kind === 'zhihu' && key !== undefined) return conflict()
  return {
    data: { tripId: input.tripId, kind: input.kind, title: input.title.trim(), excerpt: input.excerpt,
      sourceUrl: url, sourceMode: input.sourceMode, authorityLevel: input.authorityLevel,
      voteUpCount: input.voteUpCount, assetPath: input.assetPath },
    identity: input.kind === 'zhihu' ? url! : key!,
  }
}

/** Internal C-only store. No network, secrets, scheduling, fallback or public write route.
 * Call write() outside another transaction; it owns the complete write-lock boundary.
 */
export function createFindStore(db: DatabaseSync, options: { now?: () => Date } = {}) {
  function ownedTrip(tripId: string, sessionId: string) {
    if (!validId(tripId) || !validId(sessionId)) return missing()
    const row = db.prepare(`SELECT t.status, t.started_at AS startedAt, d.blocked_topics AS blockedTopics,
      d.is_sample AS isSample FROM trip t
      JOIN dog d ON d.id=t.dog_id WHERE t.id=? AND d.session_id=?`).get(tripId, sessionId)
    return row ?? missing()
  }
  function write(inputOrProof: FindInput | SearchProof, sessionId: string, verified: boolean): Find {
    return transaction(db, true, () => {
        const tripId = verified ? proofTripId(inputOrProof as SearchProof) : (inputOrProof as FindInput)?.tripId
        const trip = ownedTrip(tripId, sessionId)
        if (trip.status !== 'running' || typeof trip.startedAt !== 'string') return conflict()
        if (verified && trip.isSample === 1) return conflict()
        const input = verified ? verifiedSearchInput(inputOrProof as SearchProof, sessionId,
          JSON.parse(String(trip.blockedTopics)) as string[]) : inputOrProof as FindInput
        const { data, identity } = normalized(input, verified)
        const id = `find_${createHash('sha256').update(JSON.stringify(['c6-find-v1', data.tripId, data.kind, identity])).digest('hex')}`
        let existing = db.prepare(`SELECT ${projection} FROM find f WHERE f.id=?`).get(id) as Find | undefined
        // Respect old rows with non-deterministic IDs too, without a new index/table.
        if (!existing && data.kind === 'zhihu') {
          existing = (db.prepare(`SELECT ${projection} FROM find f WHERE f.trip_id=? AND f.kind='zhihu'
            ORDER BY f.created_at,f.id`).all(data.tripId) as unknown as Find[])
            .find(row => sourceUrl(row.sourceUrl, true) === identity)
        }
        if (existing) {
          if (Object.keys(data).some(key => {
            const field = key as keyof typeof data
            const actual = field === 'sourceUrl' && existing!.sourceUrl !== null && data.kind === 'zhihu'
              ? sourceUrl(existing!.sourceUrl, true) : existing![field]
            return actual !== data[field]
          })) return conflict()
          return { ...existing }
        }
        const at = (options.now ?? (() => new Date()))().toISOString()
        if (Date.parse(at) < Date.parse(trip.startedAt)) return conflict()
        db.prepare(`INSERT INTO find(id,trip_id,kind,title,excerpt,source_url,source_mode,authority_level,vote_up_count,asset_path,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, data.tripId, data.kind, data.title, data.excerpt,
            data.sourceUrl, data.sourceMode, data.authorityLevel, data.voteUpCount, data.assetPath, at)
        return { id, ...data, createdAt: at }
    })
  }
  return {
    list(tripId: string, sessionId: string): Find[] {
      return transaction(db, false, () => {
        ownedTrip(tripId, sessionId)
        const rows = db.prepare(`SELECT ${projection} FROM find f JOIN trip t ON t.id=f.trip_id
          JOIN dog d ON d.id=t.dog_id WHERE t.id=? AND d.session_id=? ORDER BY f.created_at,f.id`)
          .all(tripId, sessionId) as unknown as Find[]
        return rows.map(row => ({ ...row }))
      })
    },
    write(input: FindInput, sessionId: string): Find {
      return write(input, sessionId, false)
    },
    /** Trusted process-only capability; no body field can manufacture a proof. */
    writeVerified(proof: SearchProof, sessionId: string): Find {
      return write(proof, sessionId, true)
    },
  }
}

/** GET only; session ownership is never accepted from query/body fields. */
export function handleFindsRequest(request: Request, tripId: string, getDatabase: () => DatabaseSync): Response {
  const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie' }
  try {
    const sessionId = readSessionId(request)
    if (request.method !== 'GET' || !sessionId || !validId(tripId) || new URL(request.url).search) return missing()
    return Response.json({ finds: createFindStore(getDatabase()).list(tripId, sessionId) }, { headers })
  } catch (error) {
    if (error instanceof TripError) return Response.json({ code: error.code, detail: error.message, retriable: false },
      { status: error.code === 'NOT_FOUND' ? 404 : 409, headers })
    return Response.json({ code: 'NETWORK', detail: '这次没连上，可以再试一次', retriable: true }, { status: 503, headers })
  }
}
