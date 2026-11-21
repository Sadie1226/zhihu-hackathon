'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Find, Message, Trip } from '@/contracts/types'
import { tripCaption } from '@/lib/adoption/view'
import { SessionGate, useAppShell } from './shell'
import { TestBadge } from './visuals'
import { useCurrentTrip } from './use-trip'
import { orderFinds } from './content-reader'
import type { TripContent } from './ports'
import s from './shell.module.css'

type ReadState<T> = { phase: 'unavailable' | 'loading' | 'failed' } | { phase: 'ready'; value: T }
function useRead<T>(id: string, reader?: (id: string, signal: AbortSignal) => Promise<T>, revision = 0): ReadState<T> {
  const [state, setState] = useState<{ reader: typeof reader; id: string; revision: number; result: ReadState<T> } | null>(null)
  useEffect(() => {
    if (!reader) return
    const controller = new AbortController()
    void reader(id, controller.signal).then(value => {
      if (!controller.signal.aborted) setState({ reader, id, revision, result: { phase: 'ready', value } })
    }).catch(() => {
      if (!controller.signal.aborted) setState({ reader, id, revision, result: { phase: 'failed' } })
    })
    return () => controller.abort()
  }, [id, reader, revision])
  if (!reader) return { phase: 'unavailable' }
  return state?.id === id && state.reader === reader && state.revision === revision ? state.result : { phase: 'loading' }
}
function safeLink(value: string | null) {
  try { const url = new URL(value ?? ''); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined }
  catch { return undefined }
}
function ReadNotice({ phase, label, retry }: { phase: string; label: string; retry: () => void }) {
  return phase === 'unavailable' ? <p>{label}读取尚未接入。</p>
    : phase === 'loading' ? <p role="status">正在读取{label}…</p>
    : phase === 'failed' ? <p role="alert">{label}暂时没读到。 <button onClick={retry}>重读{label}</button></p> : null
}

function StoredContent({ trip, normalReturn }: { trip: Trip; normalReturn: boolean }) {
  const { bindings, session, revisions } = useAppShell()
  const [findRevision, setFindRevision] = useState(0)
  const [messageRevision, setMessageRevision] = useState(0)
  const legacy = !bindings.readFinds && !bindings.readMessage ? bindings.readTripContent : undefined
  const combined = useRead<TripContent>(trip.id, legacy, findRevision + messageRevision)
  const separateFinds = useRead<Find[]>(trip.id, bindings.readFinds, findRevision)
  const separateMessage = useRead<Message | null>(trip.id, bindings.readMessage, messageRevision)
  const finds: ReadState<Find[]> = legacy ? combined.phase === 'ready' ? { phase: 'ready', value: combined.value.finds } : combined : separateFinds
  const message: ReadState<Message | null> = legacy ? combined.phase === 'ready' ? { phase: 'ready', value: combined.value.message } : combined : separateMessage
  const actualMessage = message.phase === 'ready' && message.value?.tripId === trip.id ? message.value : null
  const Invitations = bindings.Invitations
  return <section className={s.card} aria-label={normalReturn ? '归来分享与发现' : '已保存的旅途记录'}>
    <h2>{normalReturn ? '这趟带回来的' : '已保存的记录'}</h2>
    <section aria-label="归来分享">
      <ReadNotice phase={message.phase} label="分享" retry={() => setMessageRevision(v => v + 1)} />
      {message.phase === 'ready' && (actualMessage ? <blockquote>{actualMessage.text}
        {actualMessage.mentionsFindId && finds.phase === 'ready' && finds.value.some(f => f.id === actualMessage.mentionsFindId) &&
          <> <a href={`#find-${encodeURIComponent(actualMessage.mentionsFindId)}`}>看看这条发现</a></>}
      </blockquote> : <p>这次还没有留下分享。</p>)}
    </section>
    <section aria-label="发现列表">
      <ReadNotice phase={finds.phase} label="发现" retry={() => setFindRevision(v => v + 1)} />
      {finds.phase === 'ready' && <div className={s.finds}>
        {orderFinds(finds.value, actualMessage?.mentionsFindId).map(find => <article key={find.id} id={`find-${encodeURIComponent(find.id)}`}>
          <h3>{find.title}</h3>
          {find.kind === 'zhihu' && <p className={s.source}>来源：{find.sourceMode === 'live' ? '本次读取' : find.sourceMode === 'cache' ? '缓存' : find.sourceMode === 'fixture' ? '示例资料' : '来源待核对'}</p>}
          {find.assetPath && <img src={find.assetPath} alt="" onError={event => { event.currentTarget.hidden = true }} />}
          {find.excerpt && <details><summary>查看发现内容</summary><p>{find.excerpt}</p></details>}
          {safeLink(find.sourceUrl) && <a href={safeLink(find.sourceUrl)} target="_blank" rel="noreferrer">阅读原文 ↗</a>}
        </article>)}
        {finds.value.length === 0 && <p>这次没有可展示的发现。</p>}
      </div>}
    </section>
    {normalReturn && Invitations && session?.dog && <Invitations key={`${trip.id}:${revisions.invitations ?? 0}`}
      dogId={session.dog.id} tripId={trip.id} origin="trip" returnTo="/trip" />}
  </section>
}

function TripPageBody() {
  const { session, bindings, reducedMotion } = useAppShell()
  const { trip, loading, error, retry } = useCurrentTrip(session?.dog?.id)
  const [archive, setArchive] = useState<string | null>(null)
  const returned = trip?.status === 'done'
  const interrupted = trip?.status === 'failed' || trip?.status === 'timeout'
  const visual = returned ? bindings.tripVisuals?.done : trip?.status === 'running' ? bindings.tripVisuals?.running : undefined
  const scene = visual?.src ?? (returned ? bindings.tripScenes?.done : trip?.status === 'running' ? bindings.tripScenes?.running : undefined)
  const Dog = bindings.Dog
  return <main className={s.page}>
    <Link href="/home">← 回小屋</Link><TestBadge />
    <h1>{loading ? '读一读路上的消息' : error ? trip ? '上次读到的旅途记录' : '暂时读不到它的近况' : tripCaption(trip)}</h1>
    {error && <p role="alert">{error} <button onClick={retry}>重新读取</button></p>}
    {error && trip && <p>以下是本次页面先前读到的记录，当前状态尚未确认。</p>}
    <div className={`${s.stage} ${s.tripStage}`}>
      {scene && <img className={s.tripBackdrop} src={scene} style={{ objectPosition: visual?.objectPosition }} alt={returned ? '归来场景' : '旅途场景'} />}
      {Dog && session?.dog && (returned || trip?.status === 'running') && <div className={s.tripActor} style={{ left: `${visual?.foot?.x ?? 50}%`, top: `${visual?.foot?.y ?? 88}%`, width: `${visual?.foot?.width ?? 27}%` }}>
        <Dog assembly={session.dog.assembly} reducedMotion={reducedMotion} />
      </div>}
      {!scene && <div><p>{loading || (error && !trip) ? '等出行记录读出来，再看看它的近况。' : returned ? '它已经回来了。' : interrupted ? '这趟没有正常结束，出行记录仍会保留。' : trip ? '给路上的它留一点安静。' : '它还在家里。'}</p>
        <p className={s.muted}>开发预览 · 旅途画面仍在准备中</p></div>}
    </div>
    {returned && trip && <StoredContent key={trip.id} trip={trip} normalReturn={!error} />}
    {interrupted && trip && <>
      <button onClick={() => setArchive(previous => previous === trip.id ? null : trip.id)}>查看已保存记录</button>
      {archive === trip.id && <StoredContent key={trip.id} trip={trip} normalReturn={false} />}
    </>}
  </main>
}
export default function TripPage() { return <SessionGate><TripPageBody /></SessionGate> }
