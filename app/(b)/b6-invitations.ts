// B6 · 邀请生成核心。邀请表没有 status/expires_at；状态只读 v_invitation_state。
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Find, Invitation } from '../../contracts/types.ts'
import { TripError } from '../../lib/trips/service.ts'

export const MAX_WAITING_INVITATIONS = 3

export type InvitationInput = { basedOnFindId?: string | null }
export type CreateInvitationResult = { invitation: Invitation } | { wentAlone: true; tripId: string }

type InvitationRow = {
  id: string
  dog_id: string
  text: string
  based_on_find_id: string | null
  created_at: string
}

type SourceRow = Pick<Find, 'kind' | 'title'> & { id: string }

const missing = (): never => { throw new TripError('NOT_FOUND', '这条记录不在这里') }
const conflict = (detail = '这条内容不符合要求'): never => { throw new TripError('CONFLICT', detail) }

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
}

function clip(title: string, max = 18): string {
  const value = title.trim()
  const chars = [...value]
  return chars.length <= max ? value : `${chars.slice(0, max).join('')}…`
}

/** 一条邀请 = 具体动作 + 一个理由 + 一个不做的余地；缺一条重写。 */
export function invitationText(source: SourceRow | null): string {
  if (!source) {
    return '下次路上有让你停一下的东西，拍一张给我，我想知道你停在哪。不方便就算了。'
  }
  const title = clip(source.title)
  if (source.kind === 'zhihu') {
    return `下次看到跟「${title}」有关的，拍一张给我，我想接着看。不方便就算了。`
  }
  if (source.kind === 'scene') {
    return `下次经过像「${title}」的地方，拍一张给我，我想知道后来怎样。不方便就算了。`
  }
  return `下次遇到像「${title}」这样的事，说一句给我，我想接着听。不方便就算了。`
}

function dto(row: InvitationRow): Invitation {
  return {
    id: row.id,
    dogId: row.dog_id,
    text: row.text,
    basedOnFindId: row.based_on_find_id,
    createdAt: row.created_at,
  }
}

function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = action()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function createInvitationStore(db: DatabaseSync, options: { now?: () => Date; newId?: () => string } = {}) {
  function ownedDog(dogId: string, sessionId: string): void {
    if (!validId(dogId) || !validId(sessionId) ||
        !db.prepare('SELECT 1 FROM dog WHERE id = ? AND session_id = ?').get(dogId, sessionId)) missing()
  }

  return {
    create(dogId: string, sessionId: string, input: InvitationInput): CreateInvitationResult {
      return transaction(db, () => {
        ownedDog(dogId, sessionId)
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
            Object.keys(input).some(key => !['basedOnFindId'].includes(key))) conflict()
        const basedOnFindId = input.basedOnFindId ?? null
        if (basedOnFindId !== null && !validId(basedOnFindId)) conflict('找不到这条发现')

        let source: SourceRow | null = null
        if (basedOnFindId !== null) {
          source = db.prepare(`SELECT f.id, f.kind, f.title FROM find f
            JOIN trip t ON t.id = f.trip_id JOIN dog d ON d.id = t.dog_id
            WHERE f.id = ? AND t.dog_id = ? AND d.session_id = ?`)
            .get(basedOnFindId, dogId, sessionId) as (SourceRow | undefined) ?? null
          if (!source) conflict('这条发现不在这只狗的经历里')
        }

        // 先回读同一 Find 的 waiting 邀请，再判断容量。
        // 容量满时同源重试仍须幂等，不能变成 wentAlone；只有新意图才受三条上限约束。
        if (basedOnFindId !== null) {
          const duplicate = db.prepare(`SELECT i.* FROM invitation i
            JOIN v_invitation_state v ON v.invitation_id = i.id
            WHERE i.dog_id = ? AND i.based_on_find_id = ? AND v.state = 'waiting'
            ORDER BY i.created_at DESC, i.id DESC LIMIT 1`).get(dogId, basedOnFindId) as InvitationRow | undefined
          if (duplicate) return { invitation: dto(duplicate) }
        }

        const waiting = Number(db.prepare(
          "SELECT COUNT(*) AS n FROM v_invitation_state WHERE dog_id = ? AND state = 'waiting'",
        ).get(dogId)!.n)
        if (waiting >= MAX_WAITING_INVITATIONS) {
          // 不新造 trip，也不把旧邀请改状态：只返回一个真实存在的出行给宿主回看。
          // v_invitation_state 的 gone_alone 仍由 c 的下一次真实出行推导。
          const last = db.prepare(`SELECT t.id FROM trip t JOIN dog d ON d.id = t.dog_id
            WHERE t.dog_id = ? AND d.session_id = ? AND t.started_at IS NOT NULL
            ORDER BY t.started_at DESC, t.seq DESC LIMIT 1`).get(dogId, sessionId) as { id: string } | undefined
          if (!last) return conflict('还没有真实出行，不能先说它自己去了')
          return { wentAlone: true, tripId: last.id }
        }

        const text = invitationText(source)
        const length = [...text].length
        if (length < 1 || length > 200 || !text.includes('不方便就算了')) conflict()
        const id = options.newId?.() ?? `inv_${randomUUID()}`
        const createdAt = (options.now ?? (() => new Date()))().toISOString()
        db.prepare(`INSERT INTO invitation(id,dog_id,text,based_on_find_id,created_at) VALUES(?,?,?,?,?)`)
          .run(id, dogId, text, basedOnFindId, createdAt)
        const row = db.prepare('SELECT * FROM invitation WHERE id = ?').get(id) as InvitationRow
        return { invitation: dto(row) }
      })
    },
  }
}
