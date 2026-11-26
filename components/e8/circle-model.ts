import type { SourceMode } from '../../contracts/types.ts'

/** E8 本地只读视图模型，不是新的 HTTP 契约；正式适配由 A/C 审定。 */
export type CircleDog = { actor: 'dog'; id: string; name: string; isSample: boolean }
export type CirclePost = {
  id: string
  author: CircleDog
  text: string
  createdAt: string
  sourceMode: SourceMode | null
  interactions: { dog: CircleDog; kind: 'like' | 'comment'; text?: string }[]
}
export type CircleReader = (dogId: string, signal: AbortSignal) => Promise<{ posts: CirclePost[] }>

export function circleSource(mode: SourceMode | null): string {
  switch (mode) {
    case 'fixture': return '示例动态'
    case 'cache': return '先前保存的动态'
    case 'live': return '已提供来源的动态'
    default: return '来源信息未提供'
  }
}

function validDog(dog: CircleDog): boolean {
  return dog?.actor === 'dog' && typeof dog.id === 'string' && Boolean(dog.id.trim()) &&
    typeof dog.name === 'string' && Boolean(dog.name.trim()) && typeof dog.isSample === 'boolean'
}

/** 人的发布/互动不进入视图；无效时间不编日期；主题屏蔽在显示前再次过滤。 */
export function visiblePosts(posts: readonly CirclePost[], blockedTopics: readonly string[] = []): CirclePost[] {
  const blocked = blockedTopics.map(word => word.trim().normalize('NFKC').toLocaleLowerCase()).filter(Boolean)
  const hits = (text: string) => blocked.some(word => text.normalize('NFKC').toLocaleLowerCase().includes(word))
  const seen = new Set<string>()
  return posts.filter(post => {
    if (!post || typeof post.id !== 'string' || !post.id || seen.has(post.id) || !validDog(post.author) ||
      typeof post.text !== 'string' || !post.text.trim() || hits(post.text) || hits(post.author.name) ||
      !Number.isFinite(Date.parse(post.createdAt)) || ![null, 'fixture', 'cache', 'live'].includes(post.sourceMode)) return false
    seen.add(post.id)
    return true
  }).map(post => ({
    id: post.id, author: { actor: 'dog' as const, id: post.author.id, name: post.author.name, isSample: post.author.isSample },
    text: post.text, createdAt: post.createdAt, sourceMode: post.sourceMode,
    interactions: (Array.isArray(post.interactions) ? post.interactions : []).filter(item =>
      item && validDog(item.dog) && !hits(item.dog.name) &&
      (item.kind === 'like' || (item.kind === 'comment' && typeof item.text === 'string' && Boolean(item.text.trim()) && !hits(item.text)))
    ).map(item => ({
      dog: { actor: 'dog' as const, id: item.dog.id, name: item.dog.name, isSample: item.dog.isSample },
      kind: item.kind, ...(item.kind === 'comment' ? { text: item.text } : {}),
    })),
  })).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id))
}

export function circleTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}
