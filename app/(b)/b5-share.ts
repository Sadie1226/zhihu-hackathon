// B5 · 归来分享的 Message 写入能力与 B 自有只读聚合。
// 写入方边界：trip 由 c 写；message 由 b 写（contracts/schema.sql message 表）。
// 读取归 C 的 GET /api/trips/:id/message（lib/messages/read.ts）；B 不提供 HTTP 写入口，
// 由 c 的 finish 直接调用 createMessageStore().write()。多条历史策略见下方 write()。
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Find, Message } from '../../contracts/types.ts'
import { readSessionId } from '../../lib/auth/session.ts'
import { TripError } from '../../lib/trips/service.ts'
import { createFindStore } from '../../lib/trips/finds.ts'

export const noStoreHeaders = { 'Cache-Control': 'no-store', Vary: 'Cookie' } as const

export type MessageInput = {
  text: string
  mentionsFindId?: string | null
}

type MessageRow = {
  id: string
  trip_id: string
  text: string
  mentions_find_id: string | null
  created_at: string
}

type LatestRow = MessageRow & { reference_trip_id: string | null }

const missing = (): never => { throw new TripError('NOT_FOUND', '这条记录不在这里') }
const conflict = (detail = '这条内容不符合要求'): never => { throw new TripError('CONFLICT', detail) }

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
}

function dto(row: MessageRow): Message {
  return {
    id: row.id,
    tripId: row.trip_id,
    text: row.text,
    mentionsFindId: row.mentions_find_id,
    createdAt: row.created_at,
  }
}

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

/** 话痨 20–35 字 / 寡言 8–15 字；去空白后标点算一字。没有标签时不限制在这两个区间。 */
function checkLength(text: string, tags: string | null): void {
  const length = [...text].length
  if (length < 1 || length > 120) conflict('归来的一句话要在 1 到 120 字之间')
  if (typeof tags !== 'string') return
  let parsed: unknown
  try { parsed = JSON.parse(tags) } catch { return }
  if (!Array.isArray(parsed)) return
  const labels = parsed.filter((tag): tag is string => typeof tag === 'string')
  if (labels.includes('话痨') && (length < 20 || length > 35)) conflict('话痨的归来话要 20 到 35 字')
  if (labels.includes('寡言') && (length < 8 || length > 15)) conflict('寡言的归来话要 8 到 15 字')
}

export function createMessageStore(
  db: DatabaseSync,
  options: { now?: () => Date; newId?: () => string } = {},
) {
  function ownedTrip(tripId: string, sessionId: string): { status: string; tags: string | null } {
    if (!validId(tripId) || !validId(sessionId)) return missing()
    const row = db.prepare(`SELECT t.status AS status, d.personality_tags AS tags FROM trip t
      JOIN dog d ON d.id = t.dog_id WHERE t.id = ? AND d.session_id = ?`).get(tripId, sessionId) as
      { status: string; tags: string | null } | undefined
    return row ?? missing()
  }

  return {
    /** 与 C 的 readTripMessage 同一口径：按 julianday(created_at) DESC, id DESC 取最新一条。 */
    get(tripId: string, sessionId: string): Message | null {
      return transaction(db, false, () => {
        ownedTrip(tripId, sessionId)
        const row = db.prepare(`SELECT m.*, f.trip_id AS reference_trip_id FROM message m
          LEFT JOIN find f ON f.id = m.mentions_find_id
          WHERE m.trip_id = ?
          ORDER BY julianday(m.created_at) DESC, m.id DESC LIMIT 1`).get(tripId) as LatestRow | undefined
        if (!row) return null
        // 引用的 Find 必须仍属于同一 trip；越界不回退旧行、不返回引用 ID。
        if (row.mentions_find_id !== null && row.reference_trip_id !== tripId) {
          throw new Error('Invalid Message reference')
        }
        return dto(row)
      })
    },

    /**
     * 多条历史策略（对齐 contracts/api.md 暂行提案）：
     * 每次真实生成写一条新行，保留所有历史；不引入“一趟只能一条”的写入约束或删除。
     * ID 随机唯一，重复写入相同内容也是一条新记录，由读取方取最新一条。
     */
    write(tripId: string, input: MessageInput, sessionId: string): Message {
      return transaction(db, true, () => {
        const trip = ownedTrip(tripId, sessionId)
        if (!['done', 'failed', 'timeout'].includes(trip.status)) {
          conflict('这次出行还没有回来，先不写归来分享')
        }
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
            Object.keys(input).some(key => !['text', 'mentionsFindId'].includes(key))) conflict()
        if (typeof input.text !== 'string') conflict()
        const text = input.text.trim()
        if (/[\r\n\t]/.test(text) || [...text].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) conflict()
        checkLength(text, trip.tags)

        const mention = input.mentionsFindId ?? null
        if (mention !== null) {
          if (!validId(mention)) conflict('找不到这句话对应的发现')
          const owned = db.prepare(`SELECT 1 FROM find f JOIN trip t ON t.id = f.trip_id
            JOIN dog d ON d.id = t.dog_id WHERE f.id = ? AND t.id = ? AND d.session_id = ?`)
            .get(mention, tripId, sessionId)
          if (!owned) conflict('这句话要讲这一趟自己的发现')
        }

        const id = options.newId?.() ?? `msg_${randomUUID()}`
        const createdAt = (options.now ?? (() => new Date()))().toISOString()
        db.prepare(`INSERT INTO message(id,trip_id,text,mentions_find_id,created_at) VALUES(?,?,?,?,?)`)
          .run(id, tripId, text, mention, createdAt)
        return dto(db.prepare('SELECT * FROM message WHERE id = ?').get(id) as MessageRow)
      })
    },
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof TripError) {
    return Response.json({ code: error.code, detail: error.message, retriable: false }, {
      status: error.code === 'NOT_FOUND' ? 404 : 409,
      headers: noStoreHeaders,
    })
  }
  return Response.json({ code: 'NETWORK', detail: '这次没连上，可以再试一次', retriable: true },
    { status: 503, headers: noStoreHeaders })
}

/**
 * GET /api/trips/:id/message 的可选库适配：只读，与 C 的 handleMessageReadRequest 同形状。
 * B 不挂 HTTP 写入口；写入由 c 的 finish 调 createMessageStore().write()。
 * main 已由 C 在 app/api/trips/[id]/message/route.ts 提供同名 GET，A 已绑定，故 B 不再挂载该路由。
 */
export async function handleMessageReadAdapter(
  request: Request,
  tripId: string,
  getDatabase: () => DatabaseSync,
  options: { now?: () => Date } = {},
): Promise<Response> {
  try {
    const sessionId = readSessionId(request)
    if (request.method !== 'GET' || !sessionId || !validId(tripId) || new URL(request.url).search) {
      return Response.json({ code: 'NOT_FOUND', detail: '这条记录不在这里', retriable: false },
        { status: 404, headers: noStoreHeaders })
    }
    const message = createMessageStore(getDatabase(), options).get(tripId, sessionId)
    return Response.json({ message }, { headers: noStoreHeaders })
  } catch (error) {
    return errorResponse(error)
  }
}

/** GET /api/trips/:id/content —— B 自有只读聚合 { finds, message }，路径不与 main 冲突。 */
export async function handleContentRequest(
  request: Request,
  tripId: string,
  getDatabase: () => DatabaseSync,
): Promise<Response> {
  try {
    const sessionId = readSessionId(request)
    if (request.method !== 'GET' || !sessionId || !validId(tripId) || new URL(request.url).search) {
      return Response.json({ code: 'NOT_FOUND', detail: '这条记录不在这里', retriable: false },
        { status: 404, headers: noStoreHeaders })
    }
    const db = getDatabase()
    const finds: Find[] = createFindStore(db).list(tripId, sessionId)
    const message = createMessageStore(db).get(tripId, sessionId)
    return Response.json({ finds, message }, { headers: noStoreHeaders })
  } catch (error) {
    return errorResponse(error)
  }
}
