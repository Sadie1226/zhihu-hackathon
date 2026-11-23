'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import type { Exchange, InvitationView, PublicDogSummary, Reply } from '@/contracts/types'
import { canOpen, letterState, letterTitle, safeSource } from './mailbox-model'
import { mailboxClient, type MailboxClient } from './mailbox-client'
import s from './mailbox.module.css'

type Box = 'invitations' | 'inbox' | 'outbox'
type Target = { invitationId: string; exchangeId?: never } | { exchangeId: string; invitationId?: never }
type Props = {
  dogId: string
  client?: MailboxClient
  fixture?: boolean
  revision?: number
  renderReply?: (target: Target, onReplied: (reply: Reply) => void, onClose: () => void) => ReactNode
  renderComposer?: (peer: PublicDogSummary, onCommitted: () => void, onClose: () => void) => ReactNode
  renderRelationshipActions?: (peer: PublicDogSummary) => ReactNode
}

function ExchangeText({ item }: { item: Exchange }) {
  const p = item.payload
  const text = p.kind === 'gift' ? p.note : p.kind === 'find' ? p.findExcerpt : p.kind === 'greeting' ? p.line : p.message
  const source = p.kind === 'find' ? safeSource(p.sourceUrl) : undefined
  return <><p className={s.text}>{text || '这份心意没有附言。'}</p>
    {(p.kind === 'gift' || p.kind === 'find') && <p className={s.muted}>{p.sourceMode === 'fixture' ? '示例内容' : p.sourceMode === 'cache' ? '来自先前保存的发现' : p.sourceMode === 'live' ? '来自一次知乎发现' : '来源信息未提供'}</p>}
    {source && <a href={source} target="_blank" rel="noopener noreferrer">阅读原文</a>}</>
}

export function MailboxView({ dogId, client = mailboxClient, fixture = false, revision = 0, renderReply, renderComposer, renderRelationshipActions }: Props) {
  const [box, setBox] = useState<Box>('invitations')
  const [rows, setRows] = useState<Exchange[]>([])
  const [invitations, setInvitations] = useState<InvitationView[]>([])
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [selected, setSelected] = useState<Exchange | InvitationView | null>(null)
  const [readError, setReadError] = useState('')
  const [opening, setOpening] = useState(false)
  const [replying, setReplying] = useState(false)
  const [compose, setCompose] = useState(false)
  const [peers, setPeers] = useState<PublicDogSummary[]>([])
  const [peerId, setPeerId] = useState('')
  const [peerError, setPeerError] = useState('')
  const [peerLoading, setPeerLoading] = useState(false)
  const [peerRetry, setPeerRetry] = useState(0)
  const openRequest = useRef<AbortController | null>(null)
  const detailHeading = useRef<HTMLHeadingElement | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    openRequest.current?.abort()
    setPhase('loading'); setError(''); setSelected(null); setReplying(false); setOpening(false); setReadError('')
    const request = box === 'invitations' ? client.invitations(dogId, controller.signal) : client[box](dogId, controller.signal)
    void request.then(data => {
      if (controller.signal.aborted) return
      if ('invitations' in data) setInvitations(data.invitations)
      else setRows(data.exchanges)
      setPhase('ready')
    }).catch(reason => {
      if (!controller.signal.aborted) { setPhase('error'); setError(reason instanceof Error ? reason.message : '暂时没读到来信。') }
    })
    return () => { controller.abort(); openRequest.current?.abort() }
  }, [dogId, box, client, reload, revision])

  useEffect(() => {
    const controller = new AbortController()
    setPeerLoading(true); setPeerError(''); setPeers([]); setPeerId('')
    void client.relations(dogId, controller.signal).then(data => {
      if (controller.signal.aborted) return
      const allowed = data.relations.filter(item => !item.relation.isBlocked).map(item => item.otherDog)
      setPeers(allowed); setPeerLoading(false)
    }).catch(() => { if (!controller.signal.aborted) { setPeerLoading(false); setPeerError('暂时读不到可捎话的伙伴。你的来信仍可阅读。') } })
    return () => controller.abort()
  }, [dogId, client, peerRetry])

  useEffect(() => { if (selected) detailHeading.current?.focus() }, [selected?.id])

  async function openLetter(item: Exchange) {
    if (opening || !canOpen(item, dogId)) return
    setSelected(item); setReadError(''); setReplying(false)
    if (item.readAt) return
    const controller = new AbortController()
    openRequest.current?.abort(); openRequest.current = controller; setOpening(true)
    try {
      const result = await client.read(item.id, controller.signal)
      if (controller.signal.aborted) return
      setSelected(result.exchange)
      setRows(previous => previous.map(row => row.id === item.id ? result.exchange : row))
    } catch {
      if (!controller.signal.aborted) setReadError('内容已打开，但已读状态没保存。可以重新保存。')
    } finally { if (!controller.signal.aborted) setOpening(false) }
  }

  function closeDetail() { openRequest.current?.abort(); setOpening(false); setSelected(null); setReplying(false); setReadError('') }
  const exchange = selected && 'payload' in selected ? selected : null
  const invitation = selected && !('payload' in selected) ? selected : null
  const activePeer = peers.find(peer => peer.id === peerId)
  const sender = exchange ? peers.find(peer => peer.id === exchange.fromDog) : undefined
  const peerLabel = (item: Exchange) => {
    const peer = peers.find(peer => peer.id === (item.toDog === dogId ? item.fromDog : item.toDog))
    return peer ? `${peer.name}${peer.isSample ? ' · 示例伙伴' : ''}` : '伙伴身份信息暂未读到'
  }

  return <div className={s.page}>
    <header className={s.top}><Link className={s.brand} href="/home">看山出门</Link><Link href="/home">回小屋</Link></header>
    <main id="content">
      {fixture && <p className={s.notice}>示例预览 · 所有来信与伙伴均为夹具。操作只影响当前预览，不会联系真人。</p>}
      <div className={s.heading}><div><h1>来信</h1><p className={s.intro}>有些话，会在路上多走一会儿。</p></div>
        <button className={s.primary} onClick={() => { setCompose(!compose); closeDetail() }} aria-expanded={compose}>捎句话</button></div>
      {compose && <section className={s.composer} aria-label="捎话"><h2>托它捎句话</h2>
        <p>交给伙伴慢慢带过去。对方下次出行开始时，才会收到。</p>
        {peerLoading ? <p role="status">正在看看可以捎给谁…</p> : peerError ? <><p role="alert" className={s.error}>{peerError}</p><button onClick={() => setPeerRetry(x => x + 1)}>重新读取伙伴</button></> : peers.length === 0 ? <p>还没有可以捎话的伙伴。以后在路上认识了，再来写也好。</p> : <><label htmlFor="e6-peer">捎给哪位伙伴的主人</label>
          <select id="e6-peer" value={peerId} onChange={e => setPeerId(e.target.value)}><option value="">选一位伙伴</option>{peers.map(peer => <option key={peer.id} value={peer.id}>{peer.name}{peer.isSample ? ' · 示例伙伴' : ''}</option>)}</select>
          {activePeer && <>{activePeer.isSample && <p className={s.notice}>这是一位示例伙伴，可能不会回话。</p>}
            {renderComposer ? renderComposer(activePeer, () => { setCompose(false); setBox('outbox'); setReload(x => x + 1) }, () => setCompose(false)) : <p className={s.notice}>捎话提交暂未接通，可以稍后再来。现有内容仍可阅读。</p>}
            {renderRelationshipActions ? renderRelationshipActions(activePeer) : <p className={s.muted}>举报与屏蔽操作暂未接通；目前不开放新的捎话提交。</p>}</>}
        </>}
        <button onClick={() => setCompose(false)}>先收起来</button></section>}
      <nav className={s.tabs} aria-label="来信分类">{([['invitations', '邀请与回音'], ['inbox', '朋友来信'], ['outbox', '寄出的捎话']] as const).map(([key, label]) => <button key={key} aria-pressed={box === key} onClick={() => { setBox(key); closeDetail() }}>{label}</button>)}</nav>
      {phase === 'loading' && <p role="status" className={s.notice}>正在读取这一叠信…</p>}
      {phase === 'error' && <div className={s.notice} role="alert"><p>{error}</p><button onClick={() => setReload(x => x + 1)}>重新读取</button></div>}
      {phase === 'ready' && <>
        <div className={s.actions}><button onClick={() => setReload(x => x + 1)}>刷新这一叠信</button></div>
        {!selected && <div className={s.list}>
          {box === 'invitations' ? invitations.length ? invitations.map(item => <article className={s.card} key={item.id}><div className={s.cardHead}><h2>它留给你的邀请</h2><span className={s.status}>{item.state === 'replied' ? '已回应' : item.state === 'gone_alone' ? '它先去看看了' : '安静地等着'}</span></div><p>{item.text}</p><button onClick={() => { setSelected(item); setReplying(false) }}>打开邀请</button></article>) : <Empty text="这里还没有邀请。先一起过会儿日子吧。" /> : rows.length ? rows.filter(item => box !== 'outbox' || item.kind === 'co_owner_message').map(item => <article className={s.card} key={item.id}>
            <p className={s.muted}>{peerLabel(item)}</p><div className={s.cardHead}><h2>{letterTitle(item, dogId)}</h2><span className={s.status}>{letterState(item)}</span></div>
            {!item.deliveredAt && <p className={s.muted}>{box === 'outbox' ? '对方下次出行开始时，才会收到。' : '伙伴下次出行开始时，才会带来。不用守着等。'}</p>}
            {box === 'outbox' ? <><ExchangeText item={item} /><p className={s.muted}>{item.deliveredAt ? '已经送达。不必等对方马上回应。' : '已交给伙伴，尚未送达。'}</p></> : canOpen(item, dogId) && <button disabled={opening} onClick={() => void openLetter(item)}>拆开看看</button>}
          </article>) : <Empty text={box === 'outbox' ? '还没有寄出的捎话。有想说的，再写也好。' : '信箱里还安静着。有些东西会慢慢到来。'} />}
          {box === 'outbox' && rows.length > 0 && !rows.some(item => item.kind === 'co_owner_message') && <Empty text="还没有寄出的捎话。有想说的，再写也好。" />}
        </div>}
        {selected && <section className={s.paper} aria-label="来信正文"><h2 ref={detailHeading} tabIndex={-1}>{exchange ? letterTitle(exchange, dogId) : '它留给你的邀请'}</h2>
          {exchange && <p className={s.muted}>{peerLabel(exchange)}</p>}
          {sender?.isSample && <p className={s.notice}>这是一位示例伙伴，可能不会回话。</p>}
          {sender && renderRelationshipActions?.(sender)}
          {exchange ? <ExchangeText item={exchange} /> : <p className={s.text}>{invitation?.text}</p>}
          {opening && <p role="status">正在保存已读状态…</p>}
          {readError && exchange && <p role="alert">{readError} <button onClick={() => void openLetter(exchange)}>重新保存已读</button></p>}
          <p className={s.muted}>不用现在回应。这封信会安静地留在这里。</p>
          <div className={s.actions}>{(exchange ? !exchange.repliedAt : invitation?.state !== 'replied') && <button onClick={() => setReplying(!replying)} aria-expanded={replying}>留个回应</button>}<button onClick={closeDetail}>收好，回到信箱</button></div>
          {replying && (renderReply ? renderReply(exchange ? { exchangeId: exchange.id } : { invitationId: invitation!.id }, () => { setReplying(false); closeDetail(); setReload(x => x + 1) }, () => setReplying(false)) : <p className={s.notice}>回应提交暂未接通，来信可以继续阅读。</p>)}
        </section>}
      </>}
    </main>
  </div>
}
function Empty({ text }: { text: string }) { return <div className={s.empty}><div className={s.envelope} aria-hidden="true" /><p>{text}</p></div> }
