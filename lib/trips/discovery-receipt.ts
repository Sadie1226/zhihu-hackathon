import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Find } from '../../contracts/types.ts'
import { TripError } from './errors.ts'

const hashVersion = 1
const digestPattern = /^[0-9a-f]{64}$/
const intentPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export type MemberFilter =
  | readonly ['search', string, string]
  | readonly ['observation', readonly string[] | null]
  | readonly ['event', string]
type Member = readonly [id: string, contentHash: string, filter: MemberFilter]
export type ReceiptScope = { tripId: string; dogId: string; ownerId: string | null; intentId: string }
type Receipt = { completedAt: string; members: Member[] }

export class DiscoveryReceiptIntegrityError extends Error {
  readonly code = 'DISCOVERY_RECEIPT_INVALID'
  constructor() {
    super('Invalid stored discovery receipt')
  }
}

function digest(fields: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(fields), 'utf8').digest('hex')
}

/** Compatibility for the owner entry before C10 supplies a stable server intent. */
export function ownerDiscoveryIntent(tripId: string, intentId?: string): string {
  if (intentId === undefined) return 'c6-owner:' + digest(['c6-owner-intent-v1', tripId])
  if (typeof intentId !== 'string' || !intentPattern.test(intentId)) throw new TripError('CONFLICT', '出行意图无效')
  return intentId
}

function utcInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

export function findContentHash(find: Find): string {
  const { id, tripId, kind, title, excerpt, sourceUrl, sourceMode, authorityLevel, voteUpCount, assetPath, createdAt } = find
  if (![id, tripId, kind, title, createdAt].every(value => typeof value === 'string') ||
      ![excerpt, sourceUrl, sourceMode, assetPath].every(value => value === null || typeof value === 'string') ||
      ![authorityLevel, voteUpCount].every(value => value === null || Number.isSafeInteger(value))) {
    throw new DiscoveryReceiptIntegrityError()
  }
  return digest(['c6-find-content', hashVersion, id, tripId, kind, title, excerpt, sourceUrl, sourceMode,
    authorityLevel, voteUpCount, assetPath, createdAt])
}

function validFilter(value: unknown): value is MemberFilter {
  if (!Array.isArray(value)) return false
  switch (value[0]) {
    case 'search':
      return value.length === 3 && typeof value[1] === 'string' && !!value[1].trim() &&
        typeof value[2] === 'string' && !!value[2].trim()
    case 'observation':
      return value.length === 2 && (value[1] === null ||
        (Array.isArray(value[1]) && value[1].every(topic => typeof topic === 'string')))
    case 'event':
      return value.length === 2 && typeof value[1] === 'string' && value[1].endsWith('Z') &&
        Number.isFinite(Date.parse(value[1]))
    default:
      return false
  }
}

function validMembers(members: unknown): members is Member[] {
  if (!Array.isArray(members) || members.length < 3 || members.length > 5) return false
  const ids = new Set<string>()
  for (const member of members) {
    if (!Array.isArray(member) || member.length !== 3 || typeof member[0] !== 'string' || !member[0] ||
        ids.has(member[0]) || typeof member[1] !== 'string' || !digestPattern.test(member[1]) ||
        !validFilter(member[2])) return false
    ids.add(member[0])
  }
  return true
}

function receiptHash(scope: ReceiptScope, completedAt: string, members: Member[]): string {
  return digest(['c6-discovery-receipt', hashVersion, scope.tripId, scope.dogId, scope.ownerId, scope.intentId,
    completedAt, members])
}

export function readDiscoveryReceipt(db: DatabaseSync, scope: ReceiptScope): Receipt | null {
  const row = db.prepare(`SELECT dog_id, owner_id, intent_id, completed_at, hash_version, members_json, receipt_hash
    FROM trip_discovery_receipt WHERE trip_id = ?`).get(scope.tripId)
  if (!row) return null
  if (row.dog_id !== scope.dogId || row.owner_id !== scope.ownerId || typeof row.intent_id !== 'string' ||
      !intentPattern.test(row.intent_id) || !utcInstant(row.completed_at) || row.hash_version !== hashVersion ||
      typeof row.members_json !== 'string') throw new DiscoveryReceiptIntegrityError()
  let members: unknown
  try { members = JSON.parse(row.members_json) } catch { throw new DiscoveryReceiptIntegrityError() }
  if (!validMembers(members) || receiptHash({ ...scope, intentId: row.intent_id }, row.completed_at, members) !== row.receipt_hash) {
    throw new DiscoveryReceiptIntegrityError()
  }
  if (row.intent_id !== scope.intentId) throw new TripError('CONFLICT', '这次出行已有其他执行意图的发现回执')
  return { completedAt: row.completed_at, members }
}

export function insertDiscoveryReceipt(db: DatabaseSync, scope: ReceiptScope, completedAt: string,
  entries: readonly { row: Find; filter: MemberFilter }[]): void {
  if (!db.isTransaction) throw new Error('Discovery receipt requires a write transaction')
  const members: Member[] = entries.map(({ row, filter }) => [row.id, findContentHash(row), filter])
  if (!utcInstant(completedAt) || !validMembers(members) || entries.some(({ row }) => row.tripId !== scope.tripId)) {
    throw new DiscoveryReceiptIntegrityError()
  }
  db.prepare(`INSERT INTO trip_discovery_receipt
    (trip_id, dog_id, owner_id, intent_id, completed_at, hash_version, members_json, receipt_hash)
    VALUES (?,?,?,?,?,?,?,?)`).run(scope.tripId, scope.dogId, scope.ownerId, scope.intentId, completedAt, hashVersion,
    JSON.stringify(members), receiptHash(scope, completedAt, members))
}
