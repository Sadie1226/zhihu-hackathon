'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { circleSource, circleTime, visiblePosts, type CirclePost, type CircleReader } from './circle-model'
import s from './circle.module.css'

type State = { dogId: string; phase: 'loading' | 'ready' | 'error'; posts: CirclePost[] }
export function CircleView({ dogId, blockedTopics = [], reader, fixture = false }: {
  dogId: string; blockedTopics?: readonly string[]; reader?: CircleReader; fixture?: boolean
}) {
  const [state, setState] = useState<State>({ dogId, phase: 'loading', posts: [] })
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!reader) return
    const controller = new AbortController()
    setState({ dogId, phase: 'loading', posts: [] })
    void reader(dogId, controller.signal).then(result => {
      if (!controller.signal.aborted) setState({ dogId, phase: 'ready', posts: result.posts })
    }).catch(() => {
      if (!controller.signal.aborted) setState({ dogId, phase: 'error', posts: [] })
    })
    return () => controller.abort()
  }, [dogId, reader, retry])
  const phase = state.dogId === dogId ? state.phase : 'loading'
  const posts = visiblePosts(state.dogId === dogId ? state.posts : [], blockedTopics)
  return <div className={s.page}>
    <header className={s.top}><Link href="/home">看山出门</Link><Link href="/home">回小屋</Link></header>
    <main className={s.main}>
      <h1>朋友圈</h1><p className={s.intro}>它们在路上看见的，也在这里慢慢留下。</p>
      {fixture && <p className={s.notice}>示例预览 · 动态与狗之间的互动均为夹具，不会发布或联系真人。</p>}
      {!reader ? <section className={s.notice} aria-label="动态暂未接通"><h2>这一页还没接通</h2><p>动态暂时无法读取。可以先回小屋，晚些时候再来翻翻。</p></section>
        : phase === 'loading' ? <div role="status" aria-label="正在翻看动态"><p>正在翻看它们的近况…</p><div className={s.skeleton} aria-hidden="true" /></div>
        : phase === 'error' ? <section className={s.notice} role="alert"><p>动态暂时读不到，请稍后再试。</p><button onClick={() => setRetry(value => value + 1)}>重新读取</button></section>
        : posts.length === 0 ? <p className={s.empty}>这一页还安静着。有了新见闻，再来翻翻。</p>
        : <section aria-label="狗的动态" className={s.list}>{posts.map(post => <article className={s.card} key={post.id}>
          <div className={s.meta}><h2>{post.author.name}{post.author.isSample && <span className={s.sample}> · 示例伙伴</span>}</h2><time dateTime={post.createdAt}>{circleTime(post.createdAt)}</time></div>
          <p className={s.text}>{post.text}</p>
          <p className={s.source}>{circleSource(post.sourceMode)}</p>
          {post.interactions.length > 0 && <section className={s.interactions} aria-label={`${post.author.name}的狗朋友互动`}>
            {post.interactions.map((item, index) => <p key={`${item.dog.id}-${index}`}><strong>{item.dog.name}</strong>{item.dog.isSample && <span className={s.sample}>（示例伙伴）</span>}{item.kind === 'like' ? ' 留下了一枚爪印' : `：${item.text}`}</p>)}
          </section>}
        </article>)}</section>}
    </main>
  </div>
}
