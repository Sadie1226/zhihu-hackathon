import type { ExchangesResponse, InvitationView, RelationsResponse, Exchange } from '../../contracts/types'

async function get<T>(url: string, signal: AbortSignal, method = 'GET'): Promise<T> {
  const response = await fetch(url, { method, signal, cache: 'no-store', credentials: 'same-origin',
    ...(method === 'PATCH' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}) })
  if (!response.ok) throw new Error(response.status === 404 ? '这份内容暂时不可访问，请确认登录身份。' : '暂时没读到，请稍后重新读取。')
  return await response.json() as T
}
export const mailboxClient = {
  inbox: (id: string, signal: AbortSignal) => get<ExchangesResponse>(`/api/dogs/${encodeURIComponent(id)}/inbox?filter=all`, signal),
  outbox: (id: string, signal: AbortSignal) => get<ExchangesResponse>(`/api/exchanges?from_dog=${encodeURIComponent(id)}`, signal),
  invitations: (id: string, signal: AbortSignal) => get<{ invitations: InvitationView[] }>(`/api/dogs/${encodeURIComponent(id)}/invitations`, signal),
  relations: (id: string, signal: AbortSignal) => get<RelationsResponse>(`/api/dogs/${encodeURIComponent(id)}/relations`, signal),
  read: (id: string, signal: AbortSignal) => get<{ exchange: Exchange }>(`/api/exchanges/${encodeURIComponent(id)}/read`, signal, 'PATCH'),
}
export type MailboxClient = typeof mailboxClient
