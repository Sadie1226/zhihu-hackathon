import type { Exchange } from '../../contracts/types.ts'

export function letterState(item: Exchange): string {
  if (!item.deliveredAt) return '在路上'
  if (item.repliedAt) return '已回应'
  return item.readAt ? '安静地留着' : '新到'
}

/** An incoming parcel cannot reveal its contents until the server has delivered it. */
export function canOpen(item: Exchange, dogId: string): boolean {
  return item.toDog === dogId && item.deliveredAt !== null
}

export function letterTitle(item: Exchange, dogId: string): string {
  if (item.toDog === dogId && !item.deliveredAt) return '有一份东西还在路上'
  switch (item.payload.kind) {
    case 'gift': return item.payload.giftName
    case 'find': return item.payload.findTitle
    case 'greeting': return '朋友的近况'
    case 'co_owner_message': return '主人托它捎来的一句话'
  }
}

export function safeSource(value: string | null): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined
  } catch { return undefined }
}
