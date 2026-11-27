'use client'

import { useMemo, useState } from 'react'
import type { Exchange, Find, Message, PublicDogSummary, Reply, Trip } from '@/contracts/types'
import { JournalView } from './journal-view'
import type { JournalClient } from './journal-client'
import { createReadFailureFixture } from './journal-read-failure-fixture'

const DOG = 'dog_owner'
const peer: PublicDogSummary = {
  id: 'dog_seed_07', name: '青椒', isSample: true,
  assembly: { cloth: 'sweater', hat: null, glasses: 'round', face: 'waiting' },
}
const blockedPeer: PublicDogSummary = {
  id: 'dog_seed_09', name: '灰尾', isSample: true,
  assembly: { cloth: 'raincoat', hat: null, glasses: null, face: 'hopeful' },
}

const TRIPS: Trip[] = [
  {
    id: 'trip_001', dogId: DOG, seq: 1, status: 'done', trigger: 'auto',
    createdAt: '2026-11-16T01:00:00Z', startedAt: '2026-11-16T01:00:00Z',
    endedAt: '2026-11-16T01:04:00Z', wishId: null,
  },
  {
    id: 'trip_002', dogId: DOG, seq: 2, status: 'timeout', trigger: 'wish',
    createdAt: '2026-11-20T09:10:00Z', startedAt: '2026-11-20T09:10:00Z',
    endedAt: '2026-11-20T09:50:00Z', wishId: null,
  },
]

const FINDS: Record<string, Find[]> = {
  trip_001: [
    {
      id: 'find_s1', tripId: 'trip_001', kind: 'scene', title: '喀纳斯',
      excerpt: '湖面把整片云含住了，风一停就能看见底。', sourceUrl: null, sourceMode: null,
      authorityLevel: null, voteUpCount: null, assetPath: null, createdAt: '2026-11-16T01:02:00Z',
    },
    {
      id: 'find_z1', tripId: 'trip_001', kind: 'zhihu', title: '为什么秋天的白桦先黄',
      excerpt: '叶片里的氮被提前收回，颜色就留不住了。', sourceUrl: 'https://www.zhihu.com/question/123',
      sourceMode: 'live', authorityLevel: 3, voteUpCount: 128, assetPath: null,
      createdAt: '2026-11-16T01:03:00Z',
    },
  ],
  trip_002: [],
}

const MESSAGES: Record<string, Message | null> = {
  trip_001: { id: 'msg_001', tripId: 'trip_001', text: '湖面很静，我站了一会儿。', mentionsFindId: 'find_s1', createdAt: '2026-11-16T01:04:00Z' },
  trip_002: { id: 'msg_002', tripId: 'trip_002', text: '今天回来得晚，路上绕了远。', mentionsFindId: null, createdAt: '2026-11-20T09:50:00Z' },
}

// 长正文夹具：首行 29 字（≤60，仍走渐显），余下 68 字，用来验证长信能读、不横向溢出。
const LONG_BODY = '这边入冬以后，天黑得很早，我每天回来都会绕到河边走一小段。\n水面结了一层薄冰，脚踩上去会响。上周捡到一只掉队的白鹭，站在浅滩上不动，我陪它站了很久，它才慢慢走开。如果你在，大概也会站在那里不说话。'

const INBOX: Exchange[] = [
  {
    id: 'ex_in_read', fromDog: 'dog_seed_07', toDog: DOG, kind: 'find',
    payload: { kind: 'find', findTitle: '修鞋摊旁边的搪瓷缸', findExcerpt: '缸沿上磕了两个口，茶还是满的。', sourceUrl: null, sourceMode: 'fixture' },
    deliverAfterTripSeq: 1, createdAt: '2026-11-15T10:00:00Z',
    deliveredAt: '2026-11-16T01:00:00Z', repliedAt: null, readAt: '2026-11-16T02:00:00Z',
  },
  {
    id: 'ex_in_new', fromDog: 'dog_seed_07', toDog: DOG, kind: 'greeting',
    payload: { kind: 'greeting', line: '这边下了两天雨，你那边呢', weather: '雨' },
    deliverAfterTripSeq: 1, createdAt: '2026-11-17T10:00:00Z',
    deliveredAt: '2026-11-20T09:10:00Z', repliedAt: null, readAt: null,
  },
  {
    id: 'ex_in_gift', fromDog: 'dog_seed_09', toDog: DOG, kind: 'gift',
    payload: { kind: 'gift', giftName: '一小卷灰蓝色的毛线', note: '天气要冷了', imagePath: null, sourceMode: 'fixture' },
    deliverAfterTripSeq: 1, createdAt: '2026-11-18T10:00:00Z',
    deliveredAt: '2026-11-20T09:10:00Z', repliedAt: null, readAt: null,
  },
  {
    id: 'ex_in_long', fromDog: 'dog_seed_07', toDog: DOG, kind: 'find',
    payload: { kind: 'find', findTitle: '河边的一封长信', findExcerpt: LONG_BODY, sourceUrl: null, sourceMode: 'fixture' },
    deliverAfterTripSeq: 1, createdAt: '2026-11-19T10:00:00Z',
    deliveredAt: '2026-11-20T09:10:00Z', repliedAt: null, readAt: null,
  },
  {
    id: 'ex_in_sealed', fromDog: 'dog_seed_07', toDog: DOG, kind: 'find',
    payload: { kind: 'find', findTitle: '未投递秘密标题', findExcerpt: '未投递秘密正文', sourceUrl: null, sourceMode: null },
    deliverAfterTripSeq: 3, createdAt: '2026-11-21T10:00:00Z',
    deliveredAt: null, repliedAt: null, readAt: null,
  },
]

const OUTBOX: Exchange[] = [
  {
    id: 'ex_out_msg', fromDog: DOG, toDog: 'dog_seed_07', kind: 'co_owner_message',
    payload: { kind: 'co_owner_message', message: '楼下的桂花开了，你那边闻得到吗', fromOwnerOf: DOG },
    deliverAfterTripSeq: 2, createdAt: '2026-11-16T09:35:00Z',
    deliveredAt: null, repliedAt: null, readAt: null,
  },
  {
    id: 'ex_out_gift', fromDog: DOG, toDog: 'dog_seed_09', kind: 'gift',
    payload: { kind: 'gift', giftName: '一片压好的银杏叶', note: null, imagePath: null, sourceMode: null },
    deliverAfterTripSeq: 1, createdAt: '2026-11-14T09:35:00Z',
    deliveredAt: '2026-11-16T01:00:00Z', repliedAt: null, readAt: null,
  },
]

const RELATIONS = [
  {
    otherDog: peer,
    snapshot: null,
    relation: { id: 'relation_1', dogA: 'dog_seed_07', dogB: DOG, firstMetAt: '2026-11-16T01:00:00Z', lastMetAt: '2026-11-16T01:00:00Z', metCount: 1, isBlocked: false, blockedAt: null },
  },
  {
    otherDog: blockedPeer,
    snapshot: null,
    relation: { id: 'relation_2', dogA: 'dog_seed_09', dogB: DOG, firstMetAt: '2026-11-16T01:00:00Z', lastMetAt: '2026-11-16T01:00:00Z', metCount: 1, isBlocked: true, blockedAt: '2026-11-19T01:00:00Z' },
  },
]

const fail = () => Promise.reject(new Error('暂时没读到，请稍后重新读取。'))

function delay(signal: AbortSignal, ms: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
  })
}

function makeClient(scenario: string): JournalClient {
  const empty = scenario === 'empty'
  const sealedOnly = scenario === 'sealed'
  const inbox = INBOX.map(row => ({ ...row }))
  const readFailure = createReadFailureFixture(inbox)
  let messageAttempts = 0
  const review = scenario === 'review'
  const modes = ['fixture', 'cache', 'live', null] as const
  if (review) for (const [index, mode] of modes.entries()) {
    const gift = INBOX.find(item => item.kind === 'gift')!
    inbox.push({ ...gift, id: `review_gift_${index}`, payload: {
      kind: 'gift', giftName: `来源礼物${index}`, note: null, imagePath: null, sourceMode: mode,
    } })
  }
  async function guard(signal: AbortSignal) {
    if (scenario === 'slow') await delay(signal, 2500)
    if (signal.aborted) throw new Error('aborted')
  }
  return {
    trips: async (_, signal) => {
      await guard(signal)
      if (scenario === 'error') return fail()
      return { trips: empty ? [] : TRIPS }
    },
    finds: async (tripId, signal) => {
      await guard(signal)
      if (scenario === 'error') return fail()
      if (review && tripId === 'trip_001') return { finds: modes.map((mode, index) => ({
        ...FINDS.trip_001[1], id: `review_find_${index}`, title: `来源发现${index}`, sourceMode: mode,
      })) }
      return { finds: empty ? [] : FINDS[tripId] ?? [] }
    },
    message: async (tripId, signal) => {
      await guard(signal)
      if (scenario === 'error') return fail()
      if (review && tripId === 'trip_001') {
        if (signal.aborted) throw new Error('aborted')
        messageAttempts += 1
        if (messageAttempts === 1) return fail()
        await delay(signal, 600)
      }
      return { message: empty ? null : MESSAGES[tripId] ?? null }
    },
    inbox: async (_, signal) => {
      await guard(signal)
      if (scenario === 'error') return fail()
      if (empty) return { exchanges: [] }
      if (sealedOnly) return { exchanges: inbox.filter(item => item.deliveredAt === null) }
      return { exchanges: inbox }
    },
    outbox: async (_, signal) => {
      await guard(signal)
      if (scenario === 'error' || scenario === 'partial') return fail()
      return { exchanges: empty || sealedOnly ? [] : review ? [
        ...OUTBOX,
        { ...OUTBOX[1], id: 'review_out_read', readAt: '2026-11-20T10:00:00Z' },
        { ...OUTBOX[1], id: 'review_out_reply', repliedAt: '2026-11-20T11:00:00Z' },
      ] : OUTBOX }
    },
    read: async (id, signal) => {
      await guard(signal)
      if (scenario === 'read-error') return readFailure(id, signal)
      const row = inbox.find(item => item.id === id)
      if (!row || !row.deliveredAt) throw new Error('这一封还没到。')
      row.readAt = row.readAt ?? new Date().toISOString()
      return { exchange: { ...row } }
    },
    relations: async (_, signal) => {
      await guard(signal)
      if (scenario === 'error' || scenario === 'partial') return fail()
      return { relations: empty ? [] : RELATIONS }
    },
  }
}

function FixtureReply({ onReplied, onClose }: { onReplied: (reply: Reply) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const count = [...text].length
  return <form onSubmit={event => {
    event.preventDefault()
    if (!text.trim() || count > 200) return
    onReplied({ id: `reply_${Date.now()}`, exchangeId: null, invitationId: null, text: text.trim(), photoUrl: null, kind: 'text', createdAt: new Date().toISOString() })
    onClose()
  }}>
    <label htmlFor="e7-reply">回一句（示例，不送出）</label>
    <textarea id="e7-reply" value={text} onChange={event => setText(event.target.value)}
      style={{ display: 'block', width: '100%', minHeight: 120, font: 'inherit', padding: 10, border: '2px solid #ac8f69', background: '#fffaf1', color: 'inherit' }} />
    <p>{count} / 200 字</p>
    <button type="submit" disabled={!text.trim() || count > 200}>留下这句（仅预览）</button>
  </form>
}

export default function JournalPreview() {
  const [scenario, setScenario] = useState('normal')
  return <>
    <div style={{ padding: '12px 16px', background: '#eadcc6', color: '#493c30', font: '16px/1.6 "Microsoft YaHei",sans-serif' }}>
      <label htmlFor="e7-case">本地验收场景：</label>
      <select id="e7-case" value={scenario} onChange={event => setScenario(event.target.value)} style={{ minHeight: 44, font: 'inherit' }}>
        <option value="normal">正常</option>
        <option value="read-error">E9：已读首次保存失败，重试恢复</option>
        <option value="review">E7 修补：来源、归来话重试与发件状态</option>
        <option value="empty">空手账</option>
        <option value="error">全部读取失败</option>
        <option value="partial">发件读取失败</option>
        <option value="slow">读取中</option>
        <option value="sealed">只有未送达收件</option>
      </select>
    </div>
    <Preview key={scenario} scenario={scenario} />
  </>
}

function Preview({ scenario }: { scenario: string }) {
  const client = useMemo(() => makeClient(scenario), [scenario])
  return <JournalView dogId={DOG} client={client} fixture
    renderReply={(_, onReplied, onClose) => <FixtureReply onReplied={onReplied} onClose={onClose} />} />
}
