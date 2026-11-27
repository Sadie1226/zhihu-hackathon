// B5 · C10 归来接缝的生产实现。
// C 拥有 finish 事务、done/endedAt、首次确认回放与重入；本文件只提供：
//   1) 事务外、只用已确认可见 Find 的 generate；
//   2) C 已开启 BEGIN IMMEDIATE 内同步执行的写入/校验；
//   3) 按 C 给定稳定自动 ID 精确回读。
// 不另开事务、不生成随机 ID、不更新历史行、不接触邀请/回应/主人 Cookie。
import type { DatabaseSync } from 'node:sqlite'
import type { Find, Message } from '../../contracts/types.ts'
import { PERSONALITY_TAGS } from '../../contracts/types.ts'
import { readBlockedTopics } from '../trips/find-scope.ts'
import { findContentHash } from '../trips/discovery-receipt.ts'
import { blockedBy } from '../trips/search-proof.ts'
import { TripError } from '../trips/service.ts'
import { normalizeMessageText, validateMessageText } from './message-policy.ts'

export type AutomaticReturnScope = 'owner' | 'seed'
export type AutomaticReturnInput = Readonly<{
  scope: AutomaticReturnScope
  finds: readonly Readonly<Find>[]
}>
export type AutomaticReturnDraft = Readonly<{
  text: string
  mentionsFindId: string | null
}>
export type AutomaticReturnTarget = Readonly<{
  /** C 生成的稳定自动主键，格式 msg_auto_return_v1_<sha256>。 */
  id: string
  tripId: string
  createdAt: string
  /** C 在本趟确认回执中复核后的当前可见 Find。 */
  allowedFindIds: readonly string[]
}>
export type ReturnComposeInput = Readonly<{
  scope: AutomaticReturnScope
  finds: readonly Readonly<Find>[]
  personalityTags: readonly string[]
  blockedTopics: readonly string[]
}>
export type ReturnCompose = (input: ReturnComposeInput, signal: AbortSignal) => Promise<unknown> | unknown

const missing = (): never => { throw new TripError('NOT_FOUND', '这条记录不在这里') }
const changed = (): never => { throw new TripError('CONFLICT', '归来分享的出行依据已变更') }
const conflict = (detail = '这条内容不符合要求'): never => { throw new TripError('CONFLICT', detail) }
const knownTags = new Set<string>(PERSONALITY_TAGS)

/** C 与本文件共用的自动 ID 命名空间；普通历史仍为 msg_<UUID>。 */
export const AUTOMATIC_RETURN_ID_PATTERN = /^msg_auto_return_v1_[0-9a-f]{64}$/
export function isAutomaticReturnMessageId(value: unknown): value is string {
  return typeof value === 'string' && AUTOMATIC_RETURN_ID_PATTERN.test(value)
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
}

function isoInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

type TripContext = Readonly<{
  tripId: string
  status: string
  endedAt: string | null
  dogId: string
  ownerId: string | null
  isSample: number
  personalityTags: unknown
  blockedTopics: unknown
}>

function readTripContext(db: DatabaseSync, tripId: string): TripContext {
  if (!validId(tripId)) return missing()
  const row = db.prepare(`SELECT t.id AS tripId, t.status, t.ended_at AS endedAt, t.dog_id AS dogId,
    d.owner_id AS ownerId, d.is_sample AS isSample, d.personality_tags AS personalityTags,
    d.blocked_topics AS blockedTopics
    FROM trip t JOIN dog d ON d.id = t.dog_id WHERE t.id = ?`).get(tripId) as TripContext | undefined
  if (!row) return missing()
  return row
}

function readPersonalityTags(value: unknown): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : null
  if (!Array.isArray(parsed) || parsed.some(tag => typeof tag !== 'string' || !knownTags.has(tag))) {
    throw new Error('Invalid stored personality tags')
  }
  return parsed as string[]
}

const findProjection = `f.id, f.trip_id AS tripId, f.kind, f.title, f.excerpt,
  f.source_url AS sourceUrl, f.source_mode AS sourceMode, f.authority_level AS authorityLevel,
  f.vote_up_count AS voteUpCount, f.asset_path AS assetPath, f.created_at AS createdAt`

/** 回执成员 + 当前可见性双重复核；C 已做完整回执密码学校验，这里只守 B 写入边界。 */
function confirmedFinds(db: DatabaseSync, tripId: string, ids: readonly string[], topics: readonly string[]): Map<string, Find> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => !validId(id)) || new Set(ids).size !== ids.length) return changed()
  const receipt = db.prepare('SELECT members_json AS membersJson FROM trip_discovery_receipt WHERE trip_id = ?')
    .get(tripId) as { membersJson: string } | undefined
  if (!receipt || typeof receipt.membersJson !== 'string') return changed()
  let members: unknown
  try { members = JSON.parse(receipt.membersJson) } catch { return changed() }
  if (!Array.isArray(members)) return changed()
  const expected = new Map<string, string>()
  for (const member of members) {
    if (!Array.isArray(member) || member.length < 2 || !validId(member[0]) || !/^[0-9a-f]{64}$/.test(member[1])) return changed()
    expected.set(member[0], member[1])
  }
  const result = new Map<string, Find>()
  const statement = db.prepare(`SELECT ${findProjection} FROM find f WHERE f.id = ?`)
  for (const id of ids) {
    const hash = expected.get(id)
    if (!hash) return changed()
    const row = statement.get(id) as Find | undefined
    if (!row || row.tripId !== tripId || findContentHash(row) !== hash) return changed()
    if (blockedBy(topics as string[], row.title, row.excerpt ?? '')) return changed()
    result.set(id, row)
  }
  return result
}

function validateDraft(draft: unknown, tags: unknown, topics: readonly string[],
  allowed: ReadonlySet<string>): AutomaticReturnDraft {
  if (!exactKeys(draft, ['text', 'mentionsFindId'])) return conflict()
  const value = draft as { text: unknown; mentionsFindId: unknown }
  const text = validateMessageText(value.text, tags)
  if (blockedBy(topics as string[], text)) return conflict('归来话里有当前屏蔽的内容')
  let mention: string | null
  if (value.mentionsFindId === null) mention = null
  else if (!validId(value.mentionsFindId) || !allowed.has(value.mentionsFindId)) return changed()
  else mention = value.mentionsFindId
  return Object.freeze({ text, mentionsFindId: mention })
}

function clip(value: string, max: number): string {
  const chars = [...value.trim()]
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`
}

/** 受控本地生成器：只使用传入的已确认可见 Find，不带主人请求、会话或回应。 */
export function composeReturnMessage(input: ReturnComposeInput, signal: AbortSignal): AutomaticReturnDraft {
  if (signal?.aborted) throw new Error('Return generation aborted')
  if (!input || input.scope !== 'owner' && input.scope !== 'seed' ||
      !Array.isArray(input.finds) || input.finds.length === 0) changed()
  const first = input.finds[0]
  const title = clip(first.title, input.personalityTags.includes('寡言') ? 4 : 12)
  const mention = first.id
  let text: string
  if (input.personalityTags.includes('寡言')) text = `看到了${title}，心里亮了一下。`
  else if (input.personalityTags.includes('话痨')) text = `这趟看到${title}，越想越有意思，回来还忍不住琢磨。`
  else text = `这趟看到${title}，心里记下了。`
  return Object.freeze({ text, mentionsFindId: mention })
}

/**
 * C 在事务外调用。输入只有 scope 与 C 已复核的可见 Find；附带读取服务端当前人格/屏蔽，
 * 便于生成时遵守同一契约。任何输入字段伪造或状态变更都会在写入事务中被再次拒绝。
 */
export function createReturnMessageGenerator(db: DatabaseSync, options: { compose?: ReturnCompose } = {}) {
  const compose = options.compose ?? composeReturnMessage
  return async function generate(input: unknown, signal: AbortSignal): Promise<AutomaticReturnDraft> {
    if (signal?.aborted) throw new Error('Return generation aborted')
    if (!exactKeys(input, ['scope', 'finds'])) return changed()
    const value = input as AutomaticReturnInput
    if (value.scope !== 'owner' && value.scope !== 'seed' || !Array.isArray(value.finds) || value.finds.length === 0) return changed()
    const tripIds = new Set(value.finds.map(find => find?.tripId))
    if (tripIds.size !== 1) return changed()
    const [tripId] = [...tripIds]
    if (typeof tripId !== 'string') return changed()
    const context = readTripContext(db, tripId)
    if (context.status !== 'running') return changed()
    if (value.scope === 'owner' && (context.ownerId === null || context.isSample !== 0)) return missing()
    if (value.scope === 'seed' && (context.ownerId !== null || context.isSample !== 1)) return missing()
    const topics = readBlockedTopics(context.blockedTopics)
    const tags = readPersonalityTags(context.personalityTags)
    const ids = value.finds.map(find => find.id)
    const rows = confirmedFinds(db, tripId, ids, topics)
    const visible = value.finds.map(find => {
      const row = rows.get(find.id)
      if (!row || findContentHash(find as Find) !== findContentHash(row)) return changed()
      return row
    })
    const draft = await compose(Object.freeze({ scope: value.scope, finds: visible,
      personalityTags: tags, blockedTopics: topics }), signal)
    return validateDraft(draft, context.personalityTags, topics, new Set(ids))
  }
}

/**
 * 同步运行在 C 的 BEGIN IMMEDIATE 内；不开启/提交事务，只用 C 指定的稳定 ID 普通 INSERT。
 * 失败由 C 统一回滚；普通历史行既不读取为确认结果，也不被覆盖或删除。
 */
export function writeMessageInTransaction(db: DatabaseSync, target: unknown, draft: unknown): undefined {
  if (!db.isTransaction) throw new Error('B5 writer requires an existing C transaction')
  if (!exactKeys(target, ['id', 'tripId', 'createdAt', 'allowedFindIds'])) return changed()
  const value = target as AutomaticReturnTarget
  if (!isAutomaticReturnMessageId(value.id) || !validId(value.tripId) || !isoInstant(value.createdAt)) return changed()
  const context = readTripContext(db, value.tripId)
  if (context.status !== 'done' || context.endedAt !== value.createdAt) return changed()
  const topics = readBlockedTopics(context.blockedTopics)
  const rows = confirmedFinds(db, value.tripId, value.allowedFindIds, topics)
  const checked = validateDraft(draft, context.personalityTags, topics, new Set(rows.keys()))
  if (db.prepare('SELECT 1 FROM message WHERE id = ?').get(value.id)) return changed()
  db.prepare(`INSERT INTO message(id,trip_id,text,mentions_find_id,created_at) VALUES(?,?,?,?,?)`)
    .run(value.id, value.tripId, checked.text, checked.mentionsFindId, value.createdAt)
  return undefined
}

/** 精确 ID 回读；可在 C 的事务内调用，不自行开只读事务，也不回退到「最新一条」。 */
export function readAutomaticReturnMessageById(db: DatabaseSync, id: unknown): Message | null {
  if (!isAutomaticReturnMessageId(id)) return changed()
  const messageId = id as string
  const row = db.prepare(`SELECT id, trip_id AS tripId, text, mentions_find_id AS mentionsFindId,
    created_at AS createdAt FROM message WHERE id = ?`).get(messageId) as Message | undefined
  if (!row) return null
  if (!validId(row.tripId) || typeof row.text !== 'string' || !normalizeMessageText(row.text) ||
      !isoInstant(row.createdAt) || (row.mentionsFindId !== null && !validId(row.mentionsFindId))) {
    throw new Error('Invalid automatic return Message record')
  }
  return { id: id as string, tripId: row.tripId, text: row.text,
    mentionsFindId: row.mentionsFindId as string | null, createdAt: row.createdAt }
}

/** A 可直接交给 createTripReturn 的一对生产端口。 */
export function createB5ReturnPorts(db: DatabaseSync, options: { compose?: ReturnCompose } = {}) {
  return { generate: createReturnMessageGenerator(db, options), writeMessageInTransaction }
}
