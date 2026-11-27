import type { ExchangesResponse, Exchange, Find, Message, Trip } from '../../contracts/types.ts'
import { mailboxClient } from '../e6/mailbox-client.ts'

async function get<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) {
    throw new Error(response.status === 404
      ? '这一趟的记录暂时不可访问，请确认登录身份。'
      : '暂时没读到，请稍后重新读取。')
  }
  return await response.json() as T
}

/**
 * 手账只读。写信、回应、已读之外没有任何写入口；
 * 信箱与已读直接复用 E6 的客户端，不另造一套请求。
 */
export const journalClient = {
  trips: (dogId: string, signal: AbortSignal) =>
    get<{ trips: Trip[] }>(`/api/dogs/${encodeURIComponent(dogId)}/trips?limit=50`, signal),
  finds: (tripId: string, signal: AbortSignal) =>
    get<{ finds: Find[] }>(`/api/trips/${encodeURIComponent(tripId)}/finds`, signal),
  message: (tripId: string, signal: AbortSignal) =>
    get<{ message: Message | null }>(`/api/trips/${encodeURIComponent(tripId)}/message`, signal),
  inbox: mailboxClient.inbox,
  outbox: mailboxClient.outbox,
  read: mailboxClient.read,
  relations: mailboxClient.relations,
}

export type JournalClient = {
  trips: (dogId: string, signal: AbortSignal) => Promise<{ trips: Trip[] }>
  finds: (tripId: string, signal: AbortSignal) => Promise<{ finds: Find[] }>
  message: (tripId: string, signal: AbortSignal) => Promise<{ message: Message | null }>
  inbox: (dogId: string, signal: AbortSignal) => Promise<ExchangesResponse>
  outbox: (dogId: string, signal: AbortSignal) => Promise<ExchangesResponse>
  read: (exchangeId: string, signal: AbortSignal) => Promise<{ exchange: Exchange }>
  relations: (dogId: string, signal: AbortSignal) => Promise<{ relations: import('../../contracts/types.ts').RelationView[] }>
}
