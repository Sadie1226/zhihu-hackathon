import type {
  StoredAssembly,
  TspfAssembly,
  Dog,
  InterestCategory,
  PersonalityTag,
  Trip,
} from '../../contracts/types.ts'

/** A's HTTP view. Never serialize the storage Dog, which contains sessionId. */
export type DogView = Pick<
  Dog,
  | 'id'
  | 'name'
  | 'personalityTags'
  | 'interestCategories'
  | 'isSample'
> & { assembly: StoredAssembly }
export type SessionView = {
  provider: 'development' | 'zhihu' | 'unavailable'
  authenticated: boolean
  /** Non-authorizing, namespaced UI draft key; never usable as a session credential. */
  draftScope?: string | null
  dog: DogView | null
}
export type ProfileSection = {
  status: 'ok' | 'empty' | 'error' | 'unauthorized'
  count?: number
}
export type ProfileView = {
  source: 'mock' | 'zhihu'
  version: string
  sections: Record<
    'basic' | 'collections' | 'followees' | 'contents',
    ProfileSection
  >
}
export type AdoptionDraft = {
  name: string
  interestCategories: InterestCategory[] | null
  tendencies: number[]
}
export type GenerationView = {
  tags: [PersonalityTag, PersonalityTag, PersonalityTag]
  fingerprint: string
  source: 'mock' | 'zhihu'
}
export type CreateDogInput = AdoptionDraft & {
  assembly: TspfAssembly
  fingerprint: string
  requestId: string
}

export function currentTrip(trips: Trip[]): Trip | null {
  const active = trips.filter(
    (trip) => trip.status === 'pending' || trip.status === 'running',
  )
  if (active.length > 1) throw new Error('出行记录需要重新核对')
  return active[0] ?? [...trips].sort((a, b) => b.seq - a.seq)[0] ?? null
}

export function tripCaption(trip: Trip | null): string {
  if (!trip) return '它在家里，慢慢过今天。'
  return {
    pending: '它正在收拾随身的小包。',
    running: '它出门了，沿途的事回来再聊。',
    done: '它回来了，带着一些路上的见闻。',
    timeout: '这趟出行暂时没能确认结果。',
    failed: '这趟没能走完，已有的经历还在。',
  }[trip.status]
}
