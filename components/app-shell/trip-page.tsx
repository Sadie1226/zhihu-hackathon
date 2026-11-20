'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { tripCaption } from '@/lib/adoption/view'
import { SessionGate, useAppShell } from './shell'
import type { TripContent } from './ports'
import { TestBadge } from './visuals'
import { useCurrentTrip } from './use-trip'
import s from './shell.module.css'

function safeLink(value: string | null) {
  try {
    const url = new URL(value ?? '')
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}
function TripPageBody() {
  const { session, bindings } = useAppShell()
  const { trip, loading, error, retry } = useCurrentTrip(session?.dog?.id)
  const [content, setContent] = useState<TripContent | null>(null)
  const [contentError, setContentError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    setContent(null)
    setContentError('')
    if (
      !trip ||
      trip.status !== 'done' ||
      !bindings.readTripContent
    )
      return
    const controller = new AbortController()
    void bindings
      .readTripContent(trip.id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setContent(value)
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setContentError('归来的内容暂时没读到，已有记录不会因此丢失。')
      })
    return () => controller.abort()
  }, [trip?.id, trip?.status, bindings.readTripContent, revision])
  const returned = trip?.status === 'done'
  const interrupted = trip?.status === 'failed' || trip?.status === 'timeout'
  const Invitations = bindings.Invitations
  const scene = returned
    ? bindings.tripScenes?.done
    : trip?.status === 'running'
      ? bindings.tripScenes?.running
      : undefined
  return (
    <main className={s.page}>
      <Link href="/home">← 回小屋</Link>
      <TestBadge />
      <h1>
        {loading
          ? '读一读路上的消息'
          : error && !trip
            ? '暂时读不到它的近况'
            : tripCaption(trip)}
      </h1>
      {error && (
        <p role="alert">
          {error} <button onClick={retry}>重新读取</button>
        </p>
      )}
      <div className={s.stage}>
        {scene ? (
          <img src={scene} alt={returned ? '归来场景' : '旅途场景'} />
        ) : (
          <div>
            <p>
              {loading || (error && !trip)
                ? '等出行记录读出来，再看看它的近况。'
                : returned
                  ? '它已经回来了。'
                  : interrupted
                    ? '这趟没有正常结束，出行记录仍会保留。'
                    : trip
                    ? '给路上的它留一点安静。'
                    : '它还在家里。'}
            </p>
            <p className={s.muted}>开发预览 · 旅途画面仍在准备中</p>
          </div>
        )}
      </div>
      {returned && (
        <section className={s.card} aria-label="归来分享与发现">
          <h2>这趟带回来的</h2>
          {!bindings.readTripContent ? (
            <p>归来内容读取接口尚未接入。</p>
          ) : contentError ? (
            <p role="alert">
              {contentError}{' '}
              <button onClick={() => setRevision((v) => v + 1)}>
                再读一次
              </button>
            </p>
          ) : !content ? (
            <p role="status">正在读归来的见闻…</p>
          ) : (
            <>
              {content.message ? (
                <blockquote>{content.message.text}</blockquote>
              ) : (
                <p>它这次还没有留下分享。</p>
              )}
              <div className={s.finds}>
                {content.finds.map((find) => (
                  <article key={find.id}>
                    <h3>{find.title}</h3>
                    {find.assetPath && <img src={find.assetPath} alt="" />}
                    <p>{find.excerpt}</p>
                    {find.kind === 'zhihu' && (
                      <>
                        <p className={s.source}>
                          来源：
                          {find.sourceMode === 'live'
                            ? '本次读取'
                            : find.sourceMode === 'cache'
                              ? '缓存'
                              : find.sourceMode === 'fixture'
                                ? '示例资料'
                                : '来源待核对'}
                        </p>
                        {safeLink(find.sourceUrl) && (
                          <a
                            href={safeLink(find.sourceUrl)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            阅读原文 ↗
                          </a>
                        )}
                      </>
                    )}
                  </article>
                ))}
              </div>
              {content.finds.length === 0 && <p>这次没有可展示的发现。</p>}
            </>
          )}
          {Invitations && trip && (
            <Invitations
              dogId={session!.dog!.id}
              tripId={trip.id}
              origin="trip"
              returnTo="/trip"
            />
          )}
        </section>
      )}
    </main>
  )
}
export default function TripPage() {
  return (
    <SessionGate>
      <TripPageBody />
    </SessionGate>
  )
}
