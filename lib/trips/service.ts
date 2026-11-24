import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { TRIPS_PER_DAY_MAX, TRIP_MIN_GAP_HOURS } from '../../contracts/types.ts'
import type { Trip, TripStatus, TripTrigger, Find, Exchange } from '../../contracts/types.ts'
import { deliverOnTripStart } from '../mailbox/deliver.mjs'
import { selectActiveWish } from '../wishes/contract.ts'
import { bindDepartureSnapshot } from './departure-snapshot.ts'
import type { BuildDepartureSnapshot } from './departure-snapshot.ts'

export class TripError extends Error {
  code: 'NOT_FOUND' | 'CONFLICT'
  constructor(code: 'NOT_FOUND' | 'CONFLICT', detail: string) {
    super(detail)
    this.code = code
  }
}
const conflict = (detail: string): never => { throw new TripError('CONFLICT', detail) }
const missing = (): never => { throw new TripError('NOT_FOUND', '这条记录不在这里') }
export type TerminalStatus = Extract<TripStatus, 'done' | 'failed' | 'timeout'>
export const isTerminal = (status: string): status is TerminalStatus =>
  status === 'done' || status === 'failed' || status === 'timeout'

type TripRow = {
  id: string; dog_id: string; seq: number; status: TripStatus; trigger: TripTrigger
  created_at: string; started_at: string | null; ended_at: string | null; wish_id: string | null
}
function tripDto(row: TripRow): Trip {
  return { id: row.id, dogId: row.dog_id, seq: row.seq, status: row.status, trigger: row.trigger,
    createdAt: row.created_at, startedAt: row.started_at, endedAt: row.ended_at, wishId: row.wish_id }
}

/** Synchronous callbacks only: the write lock spans ownership, policy, state and delivery. */
function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = action()
    db.exec('COMMIT')
    return value
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

/** Asia/Shanghai calendar day. Pending does not consume quota; every actual start does. */
export function startsOnShanghaiDay(db: DatabaseSync, dogId: string, at: string): number {
  return Number(db.prepare(`SELECT COUNT(*) n FROM trip WHERE dog_id = ?
    AND started_at IS NOT NULL AND date(started_at, '+8 hours') = date(?, '+8 hours')`).get(dogId, at)!.n)
}

export function createTripService(db: DatabaseSync, options: {
  now?: () => Date
  newId?: () => string
  buildDepartureSnapshot?: BuildDepartureSnapshot
} = {}) {
  const timestamp = () => (options.now ?? (() => new Date()))().toISOString()
  function ownedDog(dogId: string, sessionId: string) {
    if (!db.prepare('SELECT 1 FROM dog WHERE id = ? AND session_id = ?').get(dogId, sessionId)) missing()
  }
  function ownedTrip(id: string, sessionId: string): Trip {
    const row = db.prepare(`SELECT t.* FROM trip t JOIN dog d ON d.id = t.dog_id
      WHERE t.id = ? AND d.session_id = ?`).get(id, sessionId) as TripRow | undefined
    return row ? tripDto(row) : missing()
  }
  function quota(dogId: string, at: string) {
    if (startsOnShanghaiDay(db, dogId, at) >= TRIPS_PER_DAY_MAX) conflict('今天已经出门两次')
  }
  function finishResult(trip: Trip): { trip: Trip; finds: Find[]; message: null } {
    const finds = db.prepare(`SELECT id, trip_id AS tripId, kind, title, excerpt,
      source_url AS sourceUrl, source_mode AS sourceMode, authority_level AS authorityLevel,
      vote_up_count AS voteUpCount, asset_path AS assetPath, created_at AS createdAt
      FROM find WHERE trip_id = ? ORDER BY created_at, id`).all(trip.id) as unknown as Find[]
    return { trip, finds, message: null }
  }
  function finishInside(id: string, sessionId: string, status: TerminalStatus, at: () => string) {
    const trip = ownedTrip(id, sessionId)
    if (trip.status === status) return finishResult(trip)
    if (trip.status !== 'running') conflict('这次出行的状态不能这样更改')
    const endedAt = at()
    if (Date.parse(endedAt) < Date.parse(trip.startedAt!)) conflict('结束时间不能早于出发时间')
    db.prepare('UPDATE trip SET status = ?, ended_at = ? WHERE id = ?').run(status, endedAt, id)
    return finishResult(ownedTrip(id, sessionId))
  }
  return {
    get: ownedTrip,
    list(dogId: string, sessionId: string, limit = 10): Trip[] {
      ownedDog(dogId, sessionId)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) conflict('limit 应为 1 到 100 的整数')
      return (db.prepare('SELECT * FROM trip WHERE dog_id = ? ORDER BY seq DESC LIMIT ?')
        .all(dogId, limit) as TripRow[]).map(tripDto)
    },
    create(dogId: string, sessionId: string, trigger: TripTrigger): Trip {
      return transaction(db, () => {
        ownedDog(dogId, sessionId)
        if (!['auto', 'wish', 'friend'].includes(trigger)) conflict('trigger 应为 auto、wish 或 friend')
        if (db.prepare("SELECT 1 FROM trip WHERE dog_id = ? AND status IN ('pending','running')").get(dogId)) {
          conflict('上一次出行还没有结束')
        }
        const at = timestamp()
        quota(dogId, at)
        const seq = Number(db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 n FROM trip WHERE dog_id = ?').get(dogId)!.n)
        const id = options.newId?.() ?? `trip_${randomUUID()}`
        db.prepare(`INSERT INTO trip(id,dog_id,seq,status,trigger,created_at)
          VALUES(?,?,?,'pending',?,?)`).run(id, dogId, seq, trigger, at)
        return ownedTrip(id, sessionId)
      })
    },
    start(id: string, sessionId: string): { trip: Trip; delivered: Exchange[] } {
      return transaction(db, () => {
        const trip = ownedTrip(id, sessionId)
        if (trip.status === 'running') return { trip, delivered: [] }
        if (trip.status !== 'pending') conflict('只有待出发的任务可以开始')
        const at = timestamp()
        if (Date.parse(at) < Date.parse(trip.createdAt)) conflict('出发时间不能早于创建时间')
        quota(trip.dogId, at)
        const last = db.prepare(`SELECT started_at FROM trip WHERE dog_id = ? AND started_at IS NOT NULL
          ORDER BY julianday(started_at) DESC LIMIT 1`).get(trip.dogId)
        if (last && Date.parse(at) - Date.parse(String(last.started_at)) < TRIP_MIN_GAP_HOURS * 3600000) {
          conflict('两次出发需要间隔至少 6 小时')
        }
        if (options.buildDepartureSnapshot) bindDepartureSnapshot(db, trip, at, options.buildDepartureSnapshot)
        // Resolve at actual departure, under this write lock, so a wish revoked
        // while pending cannot become the provenance of a future trip.
        const wish = trip.trigger === 'wish' ? selectActiveWish(db, trip.dogId, sessionId) : null
        db.prepare("UPDATE trip SET status = 'running', started_at = ?, wish_id = ? WHERE id = ?")
          .run(at, wish?.id ?? null, id)
        const { deliveredIds } = deliverOnTripStart(db, trip.dogId, trip.seq, at)
        const delivered = deliveredIds.map(exchangeId => {
          const row = db.prepare(`SELECT id, from_dog AS fromDog, to_dog AS toDog, kind, payload,
            deliver_after_trip_seq AS deliverAfterTripSeq, created_at AS createdAt,
            delivered_at AS deliveredAt, replied_at AS repliedAt, read_at AS readAt
            FROM exchange WHERE id = ?`).get(exchangeId)!
          return { ...row, payload: JSON.parse(String(row.payload)) } as unknown as Exchange
        })
        return { trip: ownedTrip(id, sessionId), delivered }
      })
    },
    finish(id: string, sessionId: string, status: TerminalStatus) {
      if (!isTerminal(status)) conflict('status 应为 done、failed 或 timeout')
      return transaction(db, () => finishInside(id, sessionId, status, timestamp))
    },
    /** Internal executor hook. Undefined duration disables elapsed-time termination; no scheduler here. */
    timeoutIfDue(id: string, sessionId: string, timeoutMs?: number) {
      if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
        throw new Error('timeoutMs must be a positive integer')
      }
      return transaction(db, () => {
        const trip = ownedTrip(id, sessionId)
        if (timeoutMs === undefined || trip.status !== 'running') return null
        const at = timestamp()
        if (Date.parse(at) - Date.parse(trip.startedAt!) < timeoutMs) return null
        return finishInside(id, sessionId, 'timeout', () => at)
      })
    },
  }
}
