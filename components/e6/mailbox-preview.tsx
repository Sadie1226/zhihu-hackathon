'use client'

import { useMemo, useState } from 'react'
import type { Exchange, PublicDogSummary } from '@/contracts/types'
import { MailboxView } from './mailbox-view'
import type { MailboxClient } from './mailbox-client'
import raw from '@/contracts/fixtures/exchange.json'

const sample: PublicDogSummary = { id: 'dog_seed_07', name: '青椒', isSample: true,
  assembly: { cloth: 'sweater', hat: null, glasses: 'round', face: 'waiting' } }

function Composer({ peer, onCommit }: { peer: PublicDogSummary; onCommit: (text: string) => void }) {
  const [text, setText] = useState('')
  const count = [...text].length
  return <form onSubmit={event => { event.preventDefault(); if (text.trim() && count <= 200) onCommit(text.trim()) }}>
    <label htmlFor="e6-message">想捎的话</label>
    <textarea id="e6-message" value={text} onChange={event => setText(event.target.value)} aria-describedby="e6-count" />
    <p id="e6-count">{count} / 200 字 · {peer.isSample ? '示例伙伴不会产生真人回复' : '不用等对方马上回话'}</p>
    {count > 200 && <p role="alert">请缩短到 200 字以内。</p>}
    <button type="submit" disabled={!text.trim() || count > 200}>交给伙伴（仅预览）</button>
  </form>
}

export default function MailboxPreview() {
  const [scenario, setScenario] = useState('normal')
  return <><div style={{ padding: '12px 24px', background: '#eadcc6' }}><label htmlFor="e6-case">本地验收场景：</label><select id="e6-case" value={scenario} onChange={e => setScenario(e.target.value)}>
    <option value="normal">正常</option><option value="empty">空信箱</option><option value="error">读取失败</option><option value="read-error">已读保存失败</option><option value="slow">读取中</option><option value="blocked">伙伴已屏蔽</option>
  </select></div><Preview key={scenario} scenario={scenario} /></>
}
function Preview({ scenario }: { scenario: string }) {
  const client = useMemo<MailboxClient>(() => {
    let rows: Exchange[] = raw.exchanges.map(row => ({ id: row.id, fromDog: row.from_dog, toDog: row.to_dog,
      kind: row.kind, payload: row.payload, deliverAfterTripSeq: row.deliver_after_trip_seq,
      createdAt: row.created_at, deliveredAt: row.delivered_at, repliedAt: row.replied_at, readAt: row.read_at })) as Exchange[]
    rows.push({ ...rows[1], id: 'ex_private_pending', deliveredAt: null, readAt: null,
      payload: { kind: 'find', findTitle: '未投递秘密标题', findExcerpt: '未投递秘密正文', sourceUrl: null } })
    async function before(signal: AbortSignal) {
      if (scenario === 'slow') await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 30000); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true }) })
      if (signal.aborted) throw new Error('aborted')
      if (scenario === 'error') throw new Error('暂时没读到，请稍后重新读取。')
    }
    return {
      inbox: async (_, signal) => { await before(signal); return { exchanges: scenario === 'empty' ? [] : rows.filter(row => row.toDog === 'dog_owner') } },
      outbox: async (_, signal) => { await before(signal); return { exchanges: scenario === 'empty' ? [] : rows.filter(row => row.fromDog === 'dog_owner') } },
      invitations: async (_, signal) => { await before(signal); return { invitations: scenario === 'empty' ? [] : [{ id: 'invite_fixture', dogId: 'dog_owner', text: '下回看到桂花，可以拍一张给我吗？我想看看花开了没有。忙的话也没关系。', basedOnFindId: null, createdAt: '2026-11-23T10:00:00Z', state: 'waiting', replyId: null, goneAloneTripId: null }] } },
      relations: async (_, signal) => { await before(signal); return { relations: scenario === 'empty' ? [] : [{ otherDog: sample, snapshot: null, relation: { id: 'relation_fixture', dogA: 'dog_owner', dogB: sample.id, firstMetAt: '2026-11-16T01:00:00Z', lastMetAt: '2026-11-16T01:00:00Z', metCount: 1, isBlocked: scenario === 'blocked', blockedAt: null } }] } },
      read: async (id, signal) => {
        await before(signal)
        if (scenario === 'read-error') throw new Error('save failed')
        const row = rows.find(item => item.id === id)!
        if (!row.deliveredAt) throw new Error('not delivered')
        row.readAt ??= new Date().toISOString()
        return { exchange: { ...row } }
      },
      // Used only by the preview composer, never exported as an HTTP write adapter.
      previewSend(text: string) {
        rows = [{ ...rows[3], id: `fixture_${rows.length}`, payload: { kind: 'co_owner_message', message: text, fromOwnerOf: 'dog_owner' }, readAt: null, repliedAt: null, deliveredAt: null }, ...rows]
      },
    } as MailboxClient & { previewSend: (text: string) => void }
  }, [scenario])
  return <MailboxView dogId="dog_owner" fixture client={client}
    renderComposer={(peer, committed) => <Composer key={peer.id} peer={peer} onCommit={text => {
      (client as MailboxClient & { previewSend: (text: string) => void }).previewSend(text); committed()
    }} />}
    renderRelationshipActions={() => <p>示例操作区 · 举报与屏蔽的真实提交由 D 提供。</p>} />
}
