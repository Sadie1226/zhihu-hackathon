/** Internal, server-loaded experience. A category records search intent, not liking. */
export type Experience = Readonly<{
  id: string
  tripId: string
  seq: number
  sourceId: string
  title: string
  excerpt: string | null
  category: string | null
  kind: 'trip' | 'exchange'
}>

export type ExperienceHistory = Readonly<{
  dogId: string
  beforeSeq: number
  entries: readonly Experience[]
  fingerprint: string
}>
