'use client'
import Link from 'next/link'
import { tripCaption } from '@/lib/adoption/view'
import { SessionGate, useAppShell } from './shell'
import { DogArt, TestBadge, assetRoot } from './visuals'
import { useCurrentTrip } from './use-trip'
import s from './shell.module.css'

function Home() {
  const { session, openPanel, features, bindings } = useAppShell()
  const dog = session!.dog!
  const { trip, loading, error, retry } = useCurrentTrip(dog.id)
  return (
    <main className={s.page}>
      <p className={s.muted}>看山出门</p>
      <TestBadge />
      {dog.isSample && <p>示例伙伴</p>}
      {error && (
        <p role="alert">
          {error} <button onClick={retry}>重新读取</button>
        </p>
      )}
      <div className={s.room} aria-label="明亮的像素小屋">
        <button
          className={s.actor}
          disabled={!bindings.ChatPanel}
          aria-label="和它聊聊"
          onClick={() => openPanel('chat')}
        >
          <DogArt assembly={dog.assembly} />
        </button>
        <aside className={s.sceneUI}>
          <button
            className={s.nameplate}
            aria-label="档案"
            onClick={() => openPanel('profile')}
          >
            <h1>{dog.name}的小屋</h1>
          </button>
          <nav className={s.dock} aria-label="小屋入口">
            {(['chat', 'wish', 'mail', 'journal'] as const).map((id, i) => {
              const label = ['聊聊', '心愿', '来信', '手账'][i]
              const content = (
                <>
                  <img src={`${assetRoot}/home/${id}.png`} alt="" />
                  <span>{label}</span>
                </>
              )
              if (
                (id === 'mail' && bindings.routes?.mailbox) ||
                (id === 'journal' && bindings.routes?.journal)
              )
                return (
                  <Link key={id} href={id === 'mail' ? '/mailbox' : '/journal'}>
                    {content}
                  </Link>
                )
              const ready =
                id === 'chat'
                  ? !!bindings.ChatPanel
                  : id === 'wish'
                    ? !!bindings.WishPanel
                    : false
              return (
                <button
                  key={id}
                  disabled={!ready}
                  title={ready ? label : '模块尚未接入'}
                  onClick={() => openPanel(id)}
                >
                  {content}
                </button>
              )
            })}
            {features.map((feature) => (
              <button key={feature.id} onClick={() => openPanel(feature.id)}>
                {feature.label}
              </button>
            ))}
          </nav>
        </aside>
        <button
          className={s.sceneSettings}
          onClick={() => openPanel('settings')}
        >
          <img src={`${assetRoot}/home/settings.png`} alt="" />
          设置
        </button>
        <Link href="/trip" className={s.status}>
          {loading
            ? '正在读它的近况…'
            : error && !trip
              ? '暂时读不到它的近况'
              : tripCaption(trip)}{' '}
          →
        </Link>
      </div>
      <p className={s.muted}>
        灰色入口待对应模块接入；当前可体验领养、档案与设置。
      </p>
    </main>
  )
}
export default function HomePage() {
  return (
    <SessionGate>
      <Home />
    </SessionGate>
  )
}
