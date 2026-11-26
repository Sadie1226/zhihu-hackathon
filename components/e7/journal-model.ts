import type { Exchange, Find, Message, SourceMode, Trip } from '../../contracts/types.ts'
import { canOpen, letterState, letterTitle, safeSource } from '../e6/mailbox-model.ts'

/**
 * E7 手账只做读取与呈现。判定函数一律复用 E6，避免出现第二套「是否已送达」的口径。
 * 这里只补手账特有的三件事：收发合并、礼物归属、出行结果文案。
 */
export { canOpen, letterState, letterTitle, safeSource }

export type JournalDirection = 'in' | 'out'
export type JournalEntry = { exchange: Exchange; direction: JournalDirection }

export function directionOf(item: Exchange, dogId: string): JournalDirection | null {
  if (item.fromDog === dogId) return 'out'
  if (item.toDog === dogId) return 'in'
  return null
}

function newerFirst(left: JournalEntry, right: JournalEntry) {
  const a = left.exchange
  const b = right.exchange
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
  if (a.id === b.id) return 0
  return a.id < b.id ? 1 : -1
}

/**
 * 同一只狗的 inbox(filter=all) 与 outbox(from_dog) 按 exchange ID 去重。
 * 不新增 to_dog 查询；不属于这只狗的行直接丢弃，不当作「发件」或「收件」。
 * 两边都有同一条时保留 inbox 那一份（它带服务端最新 readAt）。
 */
export function mergeExchanges(
  inbox: readonly Exchange[],
  outbox: readonly Exchange[],
  dogId: string,
): JournalEntry[] {
  const byId = new Map<string, JournalEntry>()
  for (const item of outbox) {
    const direction = directionOf(item, dogId)
    if (direction) byId.set(item.id, { exchange: item, direction })
  }
  for (const item of inbox) {
    const direction = directionOf(item, dogId)
    if (direction) byId.set(item.id, { exchange: item, direction })
  }
  return [...byId.values()].sort(newerFirst)
}

/** 收件尚未投递：连标题都不显示，也不给拆信入口。 */
export function isSealed(entry: JournalEntry): boolean {
  return entry.direction === 'in' && entry.exchange.deliveredAt === null
}

/** 只有收件人主动拆开已送达的信才允许写已读；发件人读自己的发件不写任何时间戳。 */
export function shouldMarkRead(entry: JournalEntry): boolean {
  return entry.direction === 'in' && entry.exchange.deliveredAt !== null && entry.exchange.readAt === null
}

/**
 * 正文取用口。未送达的收件一律返回 null —— 视图拿到 null 就不渲染正文，
 * 保证业务标题与正文不会以任何形式进入 DOM。
 */
export function entryBody(entry: JournalEntry): string | null {
  if (isSealed(entry)) return null
  const payload = entry.exchange.payload
  switch (payload.kind) {
    case 'gift': return payload.note
    case 'find': return payload.findExcerpt
    case 'greeting': return payload.line
    case 'co_owner_message': return payload.message
  }
}

/** 发件状态按收件方事实展示；未送达优先，不能冒充已读或已回应。 */
export function journalLetterState(entry: JournalEntry): string {
  const item = entry.exchange
  if (entry.direction === 'in') return letterState(item)
  if (!item.deliveredAt) return '在路上'
  if (item.repliedAt) return '对方已回应'
  if (item.readAt) return '对方已读'
  return '已寄出'
}

/** 来源来自持久字段，不依据图片、链接或夹具页面自行猜测。 */
export function provenanceNote(mode: SourceMode | null | undefined): string {
  switch (mode) {
    case 'fixture': return '示例内容'
    case 'cache': return '来自先前保存的发现'
    case 'live': return '来自一次知乎发现'
    default: return '来源信息未提供'
  }
}

/** 封存收件不显示包括来源在内的内容。 */
export function sourceNote(entry: JournalEntry): string | null {
  if (isSealed(entry)) return null
  const payload = entry.exchange.payload
  if (payload.kind !== 'gift' && payload.kind !== 'find') return null
  return provenanceNote(payload.sourceMode)
}

/** 只有当前狗已经收到的礼物才进「收到的礼物」，在路上的不提前露出名字。 */
export function receivedGifts(inbox: readonly Exchange[], dogId: string): Exchange[] {
  return inbox
    .filter(item => item.kind === 'gift' && item.toDog === dogId && item.deliveredAt !== null)
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
}

export type TripTone = 'done' | 'failed' | 'timeout' | 'running' | 'pending'

export type TripOutcome = { label: string; tone: TripTone; note: string }

/**
 * failed / timeout 是正常结束的状态，但都不能写成「回来了」。
 * 超时要说清楚是超时，不能用「回来得晚」这种说法暗示它成功回来了。
 */
export function tripOutcome(trip: Trip): TripOutcome {
  switch (trip.status) {
    case 'done': return { label: '回来了', tone: 'done', note: '' }
    case 'failed': return { label: '这趟没走成', tone: 'failed', note: '这一趟没能走完，记录保留着。' }
    case 'timeout': return { label: '这次超时了', tone: 'timeout', note: '这一趟超时结束，没有按时回来。记录保留着。' }
    case 'running': return { label: '还在路上', tone: 'running', note: '这一趟还没结束，稍后再来看。' }
    default: return { label: '还没出发', tone: 'pending', note: '还没出发。' }
  }
}

const SHANGHAI = 'Asia/Shanghai'

/** 出行时间是 UTC 存储；展示按上海时间，和 C 的自然日口径一致。 */
export function formatTripMoment(trip: Trip): string | null {
  const stamp = trip.startedAt ?? trip.createdAt
  if (!stamp) return null
  const date = new Date(stamp)
  if (Number.isNaN(date.getTime())) return null
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: SHANGHAI, year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date)
  } catch {
    return null
  }
}

/**
 * 地点只从这一趟自己的 scene 发现取，取不到就返回 null，不用序号或日期顶替。
 * Trip 本身没有地点字段，所以折叠状态不显示地点，展开后才按实际数据给。
 */
export function tripPlace(finds: readonly Find[]): string | null {
  const scene = finds.find(item => item.kind === 'scene' && item.title.trim())
  return scene ? scene.title.trim() : null
}

/** 归来话缺失与「这一趟没有话」是两件事，调用方必须分开处理。 */
export function tripMessageText(message: Message | null): string | null {
  const text = message?.text?.trim()
  return text ? text : null
}

export function tripLabel(trip: Trip): string {
  return trip.seq > 0 ? `第 ${trip.seq} 次出行` : '一次出行'
}

/** 逐字渐显只处理「短首段」：第一行且不超过这个字数，超出就整段直接显示。 */
export const REVEAL_LIMIT = 60

export function revealHead(text: string): string {
  const [firstLine] = text.split('\n')
  return firstLine.length <= REVEAL_LIMIT ? firstLine : ''
}

/**
 * 什么时候才渐显：只有「新到」的收件第一次打开、用户没关、系统没要求减少动效。
 * 已读回看、发件、未送达一律直接显示全文，也不因为渐显再写一次已读。
 */
export function shouldRevealOnOpen(
  entry: JournalEntry,
  options: { revealOn: boolean; reducedMotion: boolean },
): boolean {
  if (!options.revealOn || options.reducedMotion) return false
  return entry.direction === 'in' && entry.exchange.deliveredAt !== null && entry.exchange.readAt === null
}


export type TripDetailState = {
  tripId: string
  retrying?: boolean
  phase: 'loading' | 'ready' | 'error'
  finds: Find[]
  message: Message | null
  findsError: string
  messageError: string
}

/** 重试失败不得抹掉同一趟已经成功读取的内容，也不能复用另一趟的数据。 */
export function settleTripDetail(
  tripId: string,
  finds: PromiseSettledResult<{ finds: Find[] }>,
  message: PromiseSettledResult<{ message: Message | null }>,
  previous: TripDetailState | null,
): TripDetailState {
  const kept = previous?.tripId === tripId ? previous : null
  const bothFailed = finds.status === 'rejected' && message.status === 'rejected'
  return {
    tripId,
    phase: bothFailed && kept?.phase !== 'ready' ? 'error' : 'ready',
    finds: finds.status === 'fulfilled' ? finds.value.finds : kept?.finds ?? [],
    message: message.status === 'fulfilled' ? message.value.message : kept?.message ?? null,
    findsError: finds.status === 'rejected' ? '这一趟的发现暂时读不到。' : '',
    messageError: message.status === 'rejected' ? '归来话暂时读不到。' : '',
  }
}
