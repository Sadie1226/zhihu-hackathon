import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Find } from '../../contracts/types.ts'
import { assertOwnedTrip, OwnershipError, resolveAuthContext } from '../auth/session.ts'
import { canonicalZhihuContentUrl, WishContractError } from '../wishes/contract.ts'
import {
  DiscoveryReceiptIntegrityError, findContentHash, insertDiscoveryReceipt, ownerDiscoveryIntent, readDiscoveryReceipt,
} from './discovery-receipt.ts'
import type { MemberFilter, ReceiptScope } from './discovery-receipt.ts'
import { TripError } from './errors.ts'
import { readBlockedTopics, readOwnerFindTrip } from './find-scope.ts'
import type { OwnerFindScope, SeedFindScope } from './find-scope.ts'
import { readOccurrenceFact } from './occurrence-facts.ts'
import { isFreshSearchTime } from './search-cache.ts'
import { requireSeedDiscoveryTrip } from './seed-event-scope.ts'
import {
  blockedBy, blockedByNormalizedText, eligibleSearchInput, normalizeBlockedText, proofTripId, verifiedSearchInput,
} from './search-proof.ts'
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
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
}

function sourceUrl(value: unknown): string {
  if (typeof value !== 'string' || /\s|\\/.test(value)) return conflict()
  let url: URL
  try { url = new URL(value) } catch { return conflict() }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return conflict()
  return url.href
}

function normalized(input: FindInput, verified = false, eventCapturedAt?: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['tripId', 'kind', 'title', 'excerpt', 'sourceUrl', 'sourceMode',
        'authorityLevel', 'voteUpCount', 'assetPath', 'sourceKey'].includes(key))) return conflict()
  if (!['zhihu', 'scene', 'moment'].includes(input.kind) || typeof input.title !== 'string' || !input.title.trim() ||
      !(input.excerpt === null || typeof input.excerpt === 'string')) return conflict()
  if (input.authorityLevel !== null && ![1, 2, 3, 4].includes(input.authorityLevel)) return conflict()
  if (input.voteUpCount !== null && (!Number.isSafeInteger(input.voteUpCount) || input.voteUpCount < 0)) return conflict()
  if (input.assetPath !== null && (typeof input.assetPath !== 'string' || !/^\/(?!\/)/.test(input.assetPath) ||
      /[\\?#%\s]/.test(input.assetPath) || input.assetPath.split('/').some(part => part === '.' || part === '..'))) return conflict()
  if (input.kind === 'zhihu') {
    const modes = verified ? ['live', 'cache'] : ['fixture']
    if (input.sourceMode === null || !modes.includes(input.sourceMode)) return conflict()
  } else if (input.sourceMode !== null) return conflict()
  const url = input.kind === 'zhihu' ? historicalUrl(input.sourceUrl) ?? conflict()
    : input.sourceUrl === null ? null : sourceUrl(input.sourceUrl)
  const key = input.sourceKey
  if (input.kind !== 'zhihu' && (!validId(key) || key.length > 200)) return conflict()
  if (input.kind === 'zhihu' && key !== undefined) return conflict()
  if (key?.startsWith('trip-event:') && eventCapturedAt === undefined) return conflict()
  return {
    data: { tripId: input.tripId, kind: input.kind,
      title: eventCapturedAt === undefined ? input.title.trim() : input.title, excerpt: input.excerpt,
      sourceUrl: url, sourceMode: input.sourceMode, authorityLevel: input.authorityLevel,
      voteUpCount: input.voteUpCount, assetPath: input.assetPath },
    identity: input.kind === 'zhihu' ? url! : key!,
    eventCapturedAt,
  }
}

type PreparedFind = ReturnType<typeof normalized>
export type BatchFindCandidate = { proof: SearchProof } |
  { input: FindInput; topics: readonly string[] | null }
type BatchContext = { dogId: string; startedAt: string; at: string; blockedTopics: string[] }
type SelectCandidates = (trip: BatchContext) => readonly BatchFindCandidate[]
export type EventOmission = 'EVENT_TOPICS_UNVERIFIABLE' | 'EVENT_FIND_MISMATCH'
type VisibilityReason = 'BLOCKED_TOPICS' | 'TOPIC_EVIDENCE_UNAVAILABLE'
export type DiscoveryConfirmation = { completedAt: string; replayed: boolean; visibilityReasons: VisibilityReason[] }
export class LegacyDiscoveryHoldError extends TripError {
  constructor() {
    super('CONFLICT', 'LEGACY_DISCOVERY_HOLD: 这次出行的历史发现仅供读取')
  }
}
type BatchResult = { finds: Find[]; confirmation: DiscoveryConfirmation | null; eventOmission?: EventOmission }
type ConfirmedBatch = { finds: Find[]; confirmation: DiscoveryConfirmation }

function frozenEvent(db: DatabaseSync, tripId: string, trip: BatchContext): PreparedFind | EventOmission | null {
  const fact = readOccurrenceFact(db, tripId, trip.dogId)
  if (!fact) {
    // A migrated occurrence has an explicit row with two nulls. The view also treats
    // missing storage as unverifiable, so check integrity before returning an empty result.
    if (db.prepare(`
      SELECT 1 FROM trip_event te LEFT JOIN trip_event_fact f
        ON f.trip_id = te.trip_id AND f.event_id = te.event_id
      WHERE te.trip_id = ? AND te.dog_id = ? AND (f.trip_id IS NULL OR
        (f.event_code_at_occurrence IS NULL) <> (f.public_text_at_occurrence IS NULL))
      LIMIT 1
    `).get(tripId, trip.dogId)) throw new Error('Invalid v7 occurrence fact')
    return null
  }

  const prefix = 'trip_event_fact:'
  const source: unknown = fact.sourceId.startsWith(prefix) ? JSON.parse(fact.sourceId.slice(prefix.length)) : null
  const captured = Date.parse(fact.capturedAt)
  if (!Array.isArray(source) || source.length !== 2 || source[0] !== tripId ||
      !validId(source[1]) || !fact.text.trim() || [...fact.text.trim()].length > 40 ||
      !fact.capturedAt.endsWith('Z') || !Number.isFinite(captured)) throw new Error('Invalid v7 occurrence fact')
  if (captured < Date.parse(trip.startedAt) || captured > Date.parse(trip.at) ||
      blockedBy(trip.blockedTopics, fact.text)) return null
  // The frozen text cannot clear a topic rule when the occurrence-time labels are absent.
  if (trip.blockedTopics.some(topic => topic.trim())) return 'EVENT_TOPICS_UNVERIFIABLE'

  return normalized({
    tripId, kind: 'moment', sourceKey: `trip-event:${source[1]}`, title: fact.text, excerpt: null,
    assetPath: null, sourceUrl: null, sourceMode: null, authorityLevel: null, voteUpCount: null,
  }, false, fact.capturedAt)
}

function findId({ data, identity }: PreparedFind): string {
  return 'find_' + createHash('sha256').update(JSON.stringify(['c6-find-v1', data.tripId, data.kind, identity])).digest('hex')
}

function isVisible(row: Pick<Find, 'title' | 'excerpt'>, topics: string[]): boolean {
  return !blockedBy(topics, row.title, row.excerpt ?? '')
}

function visibilityReason(row: Pick<Find, 'title' | 'excerpt'>, filter: MemberFilter, blocked: string[]): VisibilityReason | null {
  if (!isVisible(row, blocked)) return 'BLOCKED_TOPICS'
  if (filter[0] === 'search' || filter[0] === 'cache') {
    return blockedByNormalizedText(blocked, filter[1], filter[2]) ? 'BLOCKED_TOPICS' : null
  }
  if (filter[0] === 'observation' && filter[1] !== null) {
    return blockedByNormalizedText(blocked, ...filter[1]) ? 'BLOCKED_TOPICS' : null
  }
  return blocked.some(topic => topic.trim()) ? 'TOPIC_EVIDENCE_UNAVAILABLE' : null
}

function historicalUrl(value: string | null): string | null {
  try { return canonicalZhihuContentUrl(value) } catch (error) {
    if (error instanceof WishContractError) return null
    throw error
  }
}

const priority = (row: Pick<Find, 'kind'>) => row.kind === 'zhihu' ? 0 : 1
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

function sameContent(existing: Find, data: PreparedFind['data']): boolean {
  return (Object.keys(data) as (keyof typeof data)[]).every(field => {
    const value = field === 'sourceUrl' && data.kind === 'zhihu' ? historicalUrl(existing.sourceUrl) : existing[field]
    return value === data[field]
  })
}

/** Internal C-only store. No network, secrets, scheduling, fallback or public write route.
 * Call write() outside another transaction; it owns the complete write-lock boundary.
 */
export function createFindStore(db: DatabaseSync, options: { now?: () => Date } = {}) {
  function assertDiscoveryWritable(tripId: string) {
    if (db.prepare('SELECT 1 FROM trip_discovery_legacy_hold WHERE trip_id = ?').get(tripId)) {
      throw new LegacyDiscoveryHoldError()
    }
  }

  function batchContext(dogId: string, startedAt: string, blockedTopics: unknown): BatchContext {
    const at = (options.now ?? (() => new Date()))().toISOString()
    if (!(Date.parse(at) >= Date.parse(startedAt))) return conflict()
    return { dogId, startedAt, at, blockedTopics: readBlockedTopics(blockedTopics) }
  }
  function ownerBatch(tripId: string, trip: ReturnType<typeof readOwnerFindTrip>, intentId?: string, allowDone = false) {
    if ((trip.status !== 'running' && !(allowDone && trip.status === 'done')) || typeof trip.startedAt !== 'string') return conflict()
    assertDiscoveryWritable(tripId)
    return { tripId, ownerId: trip.ownerId, intentId: ownerDiscoveryIntent(tripId, intentId),
      ...batchContext(trip.dogId, trip.startedAt, trip.blockedTopics) }
  }
  function seedBatch(scope: SeedFindScope, allowDone = false) {
    const trip = requireSeedDiscoveryTrip(db, scope, allowDone)
    assertDiscoveryWritable(scope.tripId)
    return { ...scope, ownerId: null, ...batchContext(scope.dogId, trip.startedAt, trip.blockedTopics) }
  }
  function history(tripId: string): Find[] {
    return db.prepare('SELECT ' + projection + ' FROM find f WHERE f.trip_id=? ORDER BY f.created_at,f.id')
      .all(tripId) as unknown as Find[]
  }
  function findById(id: string): Find | undefined {
    return db.prepare('SELECT ' + projection + ' FROM find f WHERE f.id=?').get(id) as Find | undefined
  }
  function existingFind(entry: PreparedFind, id: string): Find | undefined {
    const { data, identity } = entry
    let existing = findById(id)
    // Historical rows may predate deterministic IDs.
    if (!existing && data.kind === 'zhihu') {
      existing = history(data.tripId).find(row => row.kind === 'zhihu' && historicalUrl(row.sourceUrl) === identity)
    }
    if (existing) {
      if (existing.tripId !== data.tripId || existing.kind !== data.kind ||
          (data.kind === 'zhihu' && historicalUrl(existing.sourceUrl) !== identity)) return conflict()
      return { ...existing }
    }
  }
  function insert({ data }: PreparedFind, id: string, at: string): Find {
    db.prepare('INSERT INTO find(id,trip_id,kind,title,excerpt,source_url,source_mode,authority_level,vote_up_count,asset_path,created_at)' +
      ' VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, data.tripId, data.kind, data.title, data.excerpt, data.sourceUrl,
      data.sourceMode, data.authorityLevel, data.voteUpCount, data.assetPath, at)
    return { id, ...data, createdAt: at }
  }
  function replayBatch(trip: BatchContext & ReceiptScope): ConfirmedBatch | null {
    const receipt = readDiscoveryReceipt(db, trip)
    if (!receipt) return null
    if (Date.parse(receipt.completedAt) < Date.parse(trip.startedAt)) throw new DiscoveryReceiptIntegrityError()
    const finds: Find[] = []
    const reasons = new Set<VisibilityReason>()
    let hasArticle = false
    for (const [id, expectedHash, filter] of receipt.members) {
      const row = findById(id)
      if (!row || row.tripId !== trip.tripId || findContentHash(row) !== expectedHash) {
        throw new DiscoveryReceiptIntegrityError()
      }
      if (filter[0] === 'search' || filter[0] === 'cache') {
        const expectedMode = filter[0] === 'cache' ? 'cache' : 'live'
        if (trip.ownerId === null || row.kind !== 'zhihu' || !historicalUrl(row.sourceUrl) ||
            row.sourceMode !== expectedMode) throw new DiscoveryReceiptIntegrityError()
        // Validate the stored acceptance fact at its original time. Replay has no current TTL gate.
        if (filter[0] === 'cache' && !isFreshSearchTime(filter[3], Date.parse(receipt.completedAt))) {
          throw new DiscoveryReceiptIntegrityError()
        }
        hasArticle = true
      } else if (filter[0] === 'event') {
        const event = frozenEvent(db, trip.tripId, { ...trip, at: receipt.completedAt, blockedTopics: [] })
        if (!event || typeof event === 'string' || event.eventCapturedAt !== filter[1] ||
            findId(event) !== id || !sameContent(row, event.data)) throw new DiscoveryReceiptIntegrityError()
      } else if (row.kind !== 'scene' && (trip.ownerId === null || row.kind !== 'moment')) {
        throw new DiscoveryReceiptIntegrityError()
      }
      const reason = visibilityReason(row, filter, trip.blockedTopics)
      if (reason) reasons.add(reason)
      else finds.push({ ...row })
    }
    if (trip.ownerId !== null && !hasArticle) throw new DiscoveryReceiptIntegrityError()
    return { finds, confirmation: { completedAt: receipt.completedAt, replayed: true, visibilityReasons: [...reasons] } }
  }

  function saveOne(input: FindInput, verified: boolean, at: string, receipt: ConfirmedBatch | null): Find {
    const entry = normalized(input, verified)
    const id = findId(entry)
    const existing = existingFind(entry, id)
    if (receipt && (!existing || !receipt.finds.some(row => row.id === existing.id))) return conflict()
    if (existing && !sameContent(existing, entry.data)) return conflict()
    return existing ?? insert(entry, id, at)
  }
  function write(inputOrProof: FindInput | SearchProof, scope: OwnerFindScope, verified: boolean, intentId?: string): Find {
    return transaction(db, true, () => {
      const tripId = verified ? proofTripId(inputOrProof as SearchProof) : (inputOrProof as FindInput)?.tripId
      const trip = ownerBatch(tripId, readOwnerFindTrip(db, tripId, scope), intentId)
      const receipt = replayBatch(trip)
      const input = verified ? verifiedSearchInput(inputOrProof as SearchProof, trip, trip.blockedTopics, trip.at)
        : inputOrProof as FindInput
      return saveOne(input, verified, trip.at, receipt)
    })
  }
  function persistBatch(trip: BatchContext & ReceiptScope, select: SelectCandidates): BatchResult {
    const prior = replayBatch(trip)
    if (prior) return prior
    const { tripId, ownerId } = trip
    const ordered = select(trip).flatMap((candidate): { entry: PreparedFind; filter: MemberFilter }[] => {
      if ('proof' in candidate) {
        if (ownerId === null) return conflict()
        const verified = eligibleSearchInput(candidate.proof, { ...trip, ownerId }, trip.blockedTopics, trip.at)
        return verified ? [{ entry: normalized(verified.input, true), filter: verified.filter }] : []
      }
      const { input, topics } = candidate
      if (input.tripId !== tripId || input.kind === 'zhihu' || (ownerId === null && input.kind !== 'scene')) return conflict()
      const entry = normalized(input)
      const filter: MemberFilter = ['observation', topics?.map(normalizeBlockedText) ?? null]
      return visibilityReason(entry.data, filter, trip.blockedTopics) ? [] : [{ entry, filter }]
    })
    const event = frozenEvent(db, tripId, trip)
    let eventOmission: EventOmission | undefined
    if (typeof event === 'string') eventOmission = event
    else if (event?.eventCapturedAt !== undefined) ordered.push({ entry: event, filter: ['event', event.eventCapturedAt] })
    ordered.sort(({ entry: a }, { entry: b }) => priority(a.data) - priority(b.data) ||
      (b.data.authorityLevel ?? 0) - (a.data.authorityLevel ?? 0) ||
      (b.data.voteUpCount ?? 0) - (a.data.voteUpCount ?? 0) ||
      compareText(a.data.kind, b.data.kind) || compareText(a.identity, b.identity) ||
      compareText(JSON.stringify(a.data), JSON.stringify(b.data)))
    let count = Number(db.prepare('SELECT count(*) AS n FROM find WHERE trip_id=?').get(tripId)?.n)
    const chosen = new Set<string>()
    const finds: { row: Find; filter: MemberFilter }[] = []
    let hasRealZhihu = false
    for (const { entry, filter } of ordered) {
      const id = findId(entry)
      if (chosen.has(id)) continue
      const existing = existingFind(entry, id)
      if (entry.eventCapturedAt !== undefined && existing &&
          (!sameContent(existing, entry.data) ||
            !(Date.parse(existing.createdAt) >= Date.parse(entry.eventCapturedAt) &&
              Date.parse(existing.createdAt) <= Date.parse(trip.at)))) {
        eventOmission = 'EVENT_FIND_MISMATCH'
        continue
      }
      if (existing && (!isVisible(existing, trip.blockedTopics) ||
          (entry.data.kind === 'zhihu' && existing.sourceMode !== entry.data.sourceMode) ||
          (entry.data.sourceMode === 'cache' && !sameContent(existing, entry.data)))) continue
      // The physical limit includes history. Owners with no proven article can leave one slot open.
      const limit = ownerId !== null && !hasRealZhihu && entry.data.kind !== 'zhihu' ? 4 : 5
      if (!existing && count >= limit) continue
      chosen.add(id)
      finds.push({ row: existing ?? insert(entry, id, trip.at), filter })
      if (!existing) count++
      if (entry.data.kind === 'zhihu') hasRealZhihu = true
    }
    finds.sort(({ row: a }, { row: b }) =>
      priority(a) - priority(b) || compareText(a.createdAt, b.createdAt) || compareText(a.id, b.id))
    const result = finds.slice(0, 5)
    if (result.length < 3 || (ownerId !== null && !hasRealZhihu)) {
      return { finds: result.map(({ row }) => row), eventOmission, confirmation: null }
    }
    insertDiscoveryReceipt(db, trip, trip.at, result)
    const checked = replayBatch(trip)
    if (!checked || checked.finds.length !== result.length) throw new DiscoveryReceiptIntegrityError()
    return { ...checked, eventOmission, confirmation: { ...checked.confirmation, replayed: false } }
  }
  return {
    /** Read the current projection under an existing transaction or a short read transaction. */
    readConfirmation(scope: { tripId: string; owner: OwnerFindScope; intentId?: string } | SeedFindScope, allowDone = false) {
      const read = () => replayBatch('owner' in scope
        ? ownerBatch(scope.tripId, readOwnerFindTrip(db, scope.tripId, scope.owner), scope.intentId, allowDone)
        : seedBatch(scope, allowDone))
      return db.isTransaction ? read() : transaction(db, false, read)
    },
    list(tripId: string, ownerId: string): Find[] {
      return transaction(db, false, () => {
        readOwnerFindTrip(db, tripId, ownerId)
        return history(tripId).map(row => ({ ...row }))
      })
    },
    write(input: FindInput, ownerId: string): Find {
      return write(input, ownerId, false)
    },
    /** The selector may synchronously resolve existing facts from this connection. */
    writeBatch(tripId: string, scope: OwnerFindScope, select: SelectCandidates, intentId?: string) {
      return transaction(db, true, () => persistBatch(ownerBatch(tripId, readOwnerFindTrip(db, tripId, scope), intentId), select))
    },
    writeSeedBatch(scope: SeedFindScope, select: SelectCandidates) {
      return transaction(db, true, () => persistBatch(seedBatch(scope), select))
    },
    prepareOwnerSearch(tripId: string, scope: OwnerFindScope, intentId?: string) {
      return transaction(db, false, () => {
        const profile = readOwnerFindTrip(db, tripId, scope)
        const trip = ownerBatch(tripId, profile, intentId)
        return { ...trip, interestCategories: profile.interestCategories, wishText: profile.wishText,
          wishCategory: profile.wishCategory, replay: replayBatch(trip) }
      })
    },
    /** Trusted process-only capability; no body field can manufacture a proof. */
    writeVerified(proof: SearchProof, scope: OwnerFindScope, intentId?: string): Find {
      return write(proof, scope, true, intentId)
    },
    /** The single-result executor yields to a batch confirmed during its external I/O. */
    commitSearchSelection(tripId: string, proof: SearchProof | null, scope: OwnerFindScope,
      intentId?: string): ConfirmedBatch | { finds: Find[] } {
      return transaction(db, true, () => {
        const trip = ownerBatch(tripId, readOwnerFindTrip(db, tripId, scope), intentId)
        const prior = replayBatch(trip)
        if (prior) return prior
        if (!proof) return { finds: [] }
        const input = verifiedSearchInput(proof, trip, trip.blockedTopics, trip.at)
        return { finds: [saveOne(input, true, trip.at, null)] }
      })
    },
  }
}

/** GET only; session ownership is never accepted from query/body fields. */
export function handleFindsRequest(request: Request, tripId: string, getDatabase: () => DatabaseSync): Response {
  const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie' }
  try {
    if (request.method !== 'GET' || !validId(tripId) || new URL(request.url).search) return missing()
    const auth = resolveAuthContext(request, getDatabase)
    if (!auth) return missing()
    const db = getDatabase()
    assertOwnedTrip(db, tripId, auth)
    return Response.json({ finds: createFindStore(db).list(tripId, auth.ownerId) }, { headers })
  } catch (error) {
    if (error instanceof OwnershipError) return Response.json({ code: error.code, detail: error.message, retriable: false },
      { status: 404, headers })
    if (error instanceof TripError) return Response.json({ code: error.code, detail: error.message, retriable: false },
      { status: error.code === 'NOT_FOUND' ? 404 : 409, headers })
    return Response.json({ code: 'NETWORK', detail: '这次没连上，可以再试一次', retriable: true }, { status: 503, headers })
  }
}
