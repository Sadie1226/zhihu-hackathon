'use client'
import Link from 'next/link'
import { useState } from 'react'
import { HomeOpenings, type OpeningKind } from '@/components/e10/home-openings'
import { tripCaption } from '@/lib/adoption/view'
import { SessionGate, useAppShell } from './shell'
import {
  Frame,
  ReferenceActor,
  A,
  cssVars,
} from '@/components/v25/presentation'
import { useCurrentTrip } from './use-trip'

function Home() {
  const { session, openPanel, features, bindings, reducedMotion } = useAppShell()
  const [openingKind, setOpeningKind] = useState<OpeningKind | null>(null)
  const dog = session!.dog!
  const { trip, loading, error, retry } = useCurrentTrip(dog.id)
  const away = trip?.status === 'running'
  const returned = trip?.status === 'done'
  const status = loading
    ? '读取中'
    : error && !trip
      ? '暂未读到'
      : away
        ? '出门了'
        : returned
          ? '刚回来'
          : trip?.status === 'pending'
            ? '准备出门'
            : trip?.status === 'timeout'
              ? '结果待确认'
              : trip?.status === 'failed'
                ? '这趟没走完'
                : '在家'
  const caption = loading
    ? '正在读它的近况…'
    : error && !trip
      ? '暂时读不到它的近况'
      : away
        ? '它出门看看了。你可以留个心愿，晚点再来。'
        : returned
          ? '我回来了，路上有件小事想告诉你。'
          : trip && trip.status !== 'done'
            ? tripCaption(trip)
            : '阳光刚好，先一起坐一会儿吧。'
  const entries = [
    { id: 'chat', label: '聊聊' },
    { id: 'wish', label: '心愿' },
    { id: 'mail', label: '来信' },
    { id: 'journal', label: '手账' },
  ]
  return (
    <Frame step="home">
      <main id="content" tabIndex={-1}>
        <section className="home-shell" aria-label="看山的小屋">
          <div className="home-room">
            <div className="scene-left-ui">
              <div className="home-top">
                <div className="nameplate v25-nameplate">
                  <button
                    className="nameplate-trigger"
                    aria-label="档案"
                    onClick={() => openPanel('profile')}
                  />
                  <img src={`${A}home/profile.png`} alt="" />
                  <span>
                    <strong id="home-name">{dog.name}的小屋</strong>
                    <small>
                      <Link
                        href="/trip"
                        className="nameplate-status"
                        aria-label={`查看旅途：${status}`}
                      >
                        {status}
                      </Link>
                    </small>
                  </span>
                </div>
                <button
                  className="settings-button"
                  onClick={() => openPanel('settings')}
                >
                  <img src={`${A}home/settings.png`} alt="" />
                  <span>设置</span>
                </button>
              </div>
              <nav className="home-dock" aria-label="小屋功能">
                {entries.map(({ id, label }) => {
                  const ready =
                    id === 'chat'
                      ? !!bindings.ChatPanel
                      : id === 'wish'
                        ? !!bindings.WishPanel
                        : false
                  const href =
                    id === 'mail' && bindings.routes?.mailbox
                      ? '/mailbox'
                      : id === 'journal' && bindings.routes?.journal
                        ? '/journal'
                        : null
                  const content = (
                    <>
                      <img src={`${A}home/${id}.png`} alt="" />
                      <span>{label}</span>
                    </>
                  )
                  return href ? (
                    <Link key={id} className="dock-route" href={href}
                      onClick={event => {
                        // Keep ordinary route URLs and modified-click/new-tab navigation.
                        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
                        event.preventDefault()
                        setOpeningKind(id === 'mail' ? 'mail' : 'journal')
                      }}>
                      {content}
                    </Link>
                  ) : (
                    <button
                      key={id}
                      data-panel={id}
                      disabled={!ready}
                      title={ready ? label : '模块尚未接入'}
                      onClick={() => openPanel(id)}
                    >
                      {content}
                    </button>
                  )
                })}
                {features.map((feature) => (
                  <button
                    key={feature.id}
                    onClick={() => openPanel(feature.id)}
                  >
                    <img src={`${A}home/journal.png`} alt="" />
                    <span>{feature.label}</span>
                  </button>
                ))}
              </nav>
            </div>
            <picture>
              <source
                media="(max-width:600px) and (orientation:portrait)"
                srcSet={`${A}home/room-tall.png`}
              />
              <img
                className="room-background"
                src={`${A}home/room-wide.png`}
                width="480"
                height="320"
                alt="明亮紧凑的小屋：蓝色窗框、浅木书桌椅、绿植、蓝边方毯和右侧庭院门，左侧为透明底素材图标"
              />
            </picture>
            {!away && (
              <button
                className="room-actor"
                disabled={!bindings.ChatPanel}
                aria-label="和看山聊聊"
                onClick={() => openPanel('chat')}
                style={cssVars({
                  '--x': `${returned ? 76 : 56.1917}%`,
                  '--y': '92.4581%',
                  '--w': '26.6312%',
                  '--tx': `${returned ? 76 : 56.1917}%`,
                  '--ty': '92.4581%',
                  '--tw': '26.6312%',
                })}
              >
                <ReferenceActor assembly={dog.assembly} />
              </button>
            )}
            <div className="room-speech" role="status">
              <Link href="/trip">{caption}</Link>
            </div>
          </div>
          {error && (
            <p role="alert">
              {error} <button onClick={retry}>重新读取</button>
            </p>
          )}
          {dog.isSample && <p className="home-demo">示例伙伴</p>}
        </section>
      </main>
      {openingKind && <HomeOpenings kind={openingKind} reducedMotion={reducedMotion} onClose={() => setOpeningKind(null)} />}
    </Frame>
  )
}
export default function HomePage() {
  return (
    <SessionGate>
      <Home />
    </SessionGate>
  )
}
