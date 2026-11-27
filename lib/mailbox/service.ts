import type { DatabaseSync } from 'node:sqlite'
import type { Exchange, ExchangeKind, ExchangePayload, ExchangesResponse, ProvenanceFields } from '../../contracts/types.ts'
import { TripError } from '../trips/service.ts'

export type InboxFilter = 'onTheWay' | 'arrived' | 'all'
type StoredExchange = Omit<Exchange, 'payload'> & { payload: string }
type MailboxRow = StoredExchange | { id: null }

const columns = `e.id, e.from_dog AS fromDog, e.to_dog AS toDog, e.kind, e.payload,
  e.deliver_after_trip_seq AS deliverAfterTripSeq, e.created_at AS createdAt,
  e.delivered_at AS deliveredAt, e.replied_at AS repliedAt, e.read_at AS readAt`

export function validMailboxId(id: string | null): id is string {
  return id !== null && id.length > 0 && id === id.trim() &&
    ![...id].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
}

function missing(): never {
  throw new TripError('NOT_FOUND', '这条记录不在这里')
}

function invalidPayload(): never {
  throw new Error('Invalid stored exchange payload')
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : invalidPayload()
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value)
}

function provenance(payload: Record<string, unknown>): ProvenanceFields {
  const fields: ProvenanceFields = {}
  if (Object.hasOwn(payload, 'sourceFindId')) fields.sourceFindId = nullableText(payload.sourceFindId)
  if (Object.hasOwn(payload, 'sourceMode')) {
    const mode = payload.sourceMode
    if (mode !== null && mode !== 'live' && mode !== 'cache' && mode !== 'fixture') invalidPayload()
    fields.sourceMode = mode
  }
  return fields
}

function decodePayload(kind: ExchangeKind, json: string): ExchangePayload {
  const value: unknown = JSON.parse(json)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidPayload()
  const payload = value as Record<string, unknown>
  if (payload.kind !== kind) return invalidPayload()

  switch (kind) {
    case 'find':
      return { kind, findTitle: text(payload.findTitle), findExcerpt: nullableText(payload.findExcerpt),
        sourceUrl: nullableText(payload.sourceUrl), ...provenance(payload) }
    case 'gift':
      return { kind, giftName: text(payload.giftName), note: nullableText(payload.note),
        imagePath: nullableText(payload.imagePath), ...provenance(payload) }
    case 'greeting':
      return { kind, line: text(payload.line), weather: nullableText(payload.weather) }
    case 'co_owner_message':
      return { kind, message: text(payload.message), fromOwnerOf: text(payload.fromOwnerOf) }
  }
}

function toExchange(row: StoredExchange): Exchange {
  return { ...row, payload: decodePayload(row.kind, row.payload) }
}

const inboxStatus = {
  onTheWay: 'AND e.delivered_at IS NULL',
  arrived: 'AND e.delivered_at IS NOT NULL',
  all: '',
} satisfies Record<InboxFilter, string>

function listOwned(db: DatabaseSync, dogId: string, sessionId: string, filter?: InboxFilter): ExchangesResponse {
  const match = filter === undefined ? 'e.from_dog = d.id' : `e.to_dog = d.id ${inboxStatus[filter]}`
  // A LEFT JOIN keeps an owned empty mailbox distinct from an unknown or foreign dog.
  const rows = db.prepare(`SELECT ${columns}
    FROM dog d LEFT JOIN exchange e ON ${match}
    WHERE d.id = ? AND d.session_id = ?
    ORDER BY e.created_at DESC, e.id DESC`).all(dogId, sessionId) as MailboxRow[]
  if (rows.length === 0) return missing()
  return { exchanges: rows.filter(row => row.id !== null).map(toExchange) }
}

export function readInbox(db: DatabaseSync, dogId: string, sessionId: string, filter: InboxFilter): ExchangesResponse {
  return listOwned(db, dogId, sessionId, filter)
}

export function readOutbox(db: DatabaseSync, dogId: string, sessionId: string): ExchangesResponse {
  return listOwned(db, dogId, sessionId)
}

/**
 * 「我在等它的回音」—— **寄件方视角，不是收件方**。
 *
 * 三个条件缺一不可：
 *   1. `deliveredAt !== null`：还没到的东西谈不上等；在路上的期待是另一回事。
 *   2. `repliedAt === null`：已经回过就不再等。
 *   3. 只有 `gift` / `co_owner_message` 这两种「带投递语义」的东西会等；
 *      `find` / `greeting` 是相遇当场交换的，没人会等一句「今天有风」的回音。
 *
 * **为什么收件方不在这个判定里**：收件狗收到东西≠欠一个回应（不变量三：不回应不惩罚）。
 * 只有**寄出的那一方**才有「等回音」这件事，而且这只是一句陈述，不是待办、不该有红点。
 *
 * 这是唯一一份实现。d5 的快照派生器（`lib/social/snapshot-derive.ts` 里的 SQL）、
 * e6 的来信页、以及 `tests/exchange-send.test.mjs` 都按它对齐；SQL 那份改条件时，
 * 这里必须一起改，否则会出现「手账说在等、快照说不等」这种对不上的状态。
 */
export function isWaitingForReply(exchange: Exchange): boolean {
  return (
    exchange.deliveredAt !== null &&
    exchange.repliedAt === null &&
    (exchange.kind === 'gift' || exchange.kind === 'co_owner_message')
  )
}

/** Called after E opens a single delivered exchange. The lock covers authorization and the returned row. */
export function markExchangeRead(db: DatabaseSync, id: string, sessionId: string): Exchange {
  db.exec('BEGIN IMMEDIATE')
  try {
    const select = db.prepare(`SELECT ${columns} FROM exchange e JOIN dog d ON d.id = e.to_dog
      WHERE e.id = ? AND d.session_id = ?`)
    const row = select.get(id, sessionId) as StoredExchange | undefined
    if (!row) return missing()
    if (row.deliveredAt === null) throw new TripError('CONFLICT', '这封来信还在路上')

    if (row.readAt === null) {
      db.prepare(`UPDATE exchange SET read_at = ?
        WHERE id = ? AND read_at IS NULL AND delivered_at IS NOT NULL`).run(new Date().toISOString(), id)
    }
    const exchange = toExchange(row.readAt === null ? select.get(id, sessionId) as StoredExchange : row)
    db.exec('COMMIT')
    return exchange
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
