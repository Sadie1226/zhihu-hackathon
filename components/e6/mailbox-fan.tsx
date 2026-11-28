'use client'

import { useState, type CSSProperties } from 'react'
import type { Exchange } from '@/contracts/types'
import { canOpen, letterState, letterTitle } from './mailbox-model'
import s from './mailbox-fan.module.css'

/** A fan is only a selector. Hovering or selecting never saves read state. */
export function MailboxFan({ rows, dogId, peerLabel, onOpen }: {
  rows: Exchange[]
  dogId: string
  peerLabel: (item: Exchange) => string
  onOpen: (item: Exchange) => void
}) {
  const [chosen, setChosen] = useState<string | null>(null)
  const groups = new Map<string, Exchange[]>()
  for (const row of rows) {
    if (row.toDog !== dogId) continue
    const group = groups.get(row.fromDog) ?? []
    group.push(row)
    groups.set(row.fromDog, group)
  }
  return <div className={s.groups}>
    <p className={s.hint}>按伙伴收好。先选一封，再拆开看看。</p>
    {[...groups].map(([peer, letters]) => <section key={peer} className={s.group} aria-label={peerLabel(letters[0])}>
      <h2>{peerLabel(letters[0])}</h2>
      <div className={s.fan}>{letters.map((item, index) => {
        const allowed = canOpen(item, dogId)
        const selected = chosen === item.id
        return <article key={item.id} className={`${s.card} ${selected ? s.chosen : ''}`}
          style={{ '--tilt': `${(index % 3 - 1) * 2}deg` } as CSSProperties}>
          <button type="button" className={s.select} disabled={!allowed} aria-pressed={selected}
            aria-label={`${allowed ? '选中：' : ''}${letterTitle(item, dogId)}`} onClick={() => setChosen(item.id)}>
            <img src="/assets/a5-v25/home/mail.png" width="80" height="62" alt="" />
            <strong>{letterTitle(item, dogId)}</strong>
            <span>{letterState(item)}</span>
          </button>
          {selected && allowed && <button type="button" className={s.open} onClick={() => onOpen(item)}>拆开看看</button>}
          {!allowed && <p className={s.hint}>还在路上，到达后再拆开。</p>}
        </article>
      })}</div>
    </section>)}
  </div>
}
