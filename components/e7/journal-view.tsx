'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import type { Exchange, PublicDogSummary, Reply, Trip } from '@/contracts/types'
import { journalClient, type JournalClient } from './journal-client'
import {
  entryBody,
  correspondence,
  isNewIncoming,
  giftThumbnail,
  formatTripMoment,
  GLYPH_FADE_MS,
  glyphDelayMs,
  isSealed,
  journalLetterState,
  provenanceNote,
  letterTitle,
  mergeExchanges,
  receivedGifts,
  revealHead,
  revealOnFrom,
  safeSource,
  settingsOpenFrom,
  shouldMarkRead,
  shouldRevealOnOpen,
  sourceNote,
  settleTripDetail,
  type TripDetailState,
  tripLabel,
  tripMessageText,
  tripOutcome,
  tripPlace,
  type JournalEntry,
} from './journal-model'
import s from './journal.module.css'

type Tab = 'trips' | 'letters' | 'gifts'
type Phase = 'loading' | 'ready' | 'error'
type MailState = {
  phase: Phase
  inbox: Exchange[]
  outbox: Exchange[]
  inboxFailed: boolean
  outboxFailed: boolean
  error: string
}
type Props = {
  dogId: string
  client?: JournalClient
  fixture?: boolean
  revision?: number
  /** 系统级「减少动态效果」；为真时逐字渐显一律关闭。 */
  reducedMotion?: boolean
  renderReply?: (target: { exchangeId: string }, onReplied: (reply: Reply) => void, onClose: () => void) => ReactNode
}

const TABS: readonly [Tab, string][] = [
  ['trips', '旅途'],
  ['letters', '来往'],
  ['gifts', '收到的礼物'],
]

const EMPTY_MAIL: MailState = { phase: 'loading', inbox: [], outbox: [], inboxFailed: false, outboxFailed: false, error: '' }

function messageOf(reason: unknown): string {
  return reason instanceof Error && reason.message ? reason.message : '暂时没读到，请稍后重新读取。'
}

export function JournalView({ dogId, client = journalClient, fixture = false, revision = 0, reducedMotion = false, renderReply }: Props) {
  const [tab, setTab] = useState<Tab>('trips')
  const [mailDirection, setMailDirection] = useState<'in' | 'out'>('in')

  const [trips, setTrips] = useState<Trip[]>([])
  const [tripPhase, setTripPhase] = useState<Phase>('loading')
  const [tripError, setTripError] = useState('')
  const [tripTick, setTripTick] = useState(0)

  const [openTrip, setOpenTrip] = useState<string | null>(null)
  const [detail, setDetail] = useState<TripDetailState | null>(null)
  const [detailTick, setDetailTick] = useState(0)

  const [mail, setMail] = useState<MailState>(EMPTY_MAIL)
  const [mailTick, setMailTick] = useState(0)

  const [peers, setPeers] = useState<PublicDogSummary[]>([])
  const [peersUnavailable, setPeersUnavailable] = useState(false)

  const [openLetterId, setOpenLetterId] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [readError, setReadError] = useState('')
  const [replying, setReplying] = useState(false)
  const [revealId, setRevealId] = useState<string | null>(null)
  const [revealOn, setRevealOn] = useState(true)
  const [revealedNow, setRevealedNow] = useState(false)
  // 二级设置默认收起：一级阅读界面只留一个入口，不直接摆开关和说明。
  const [settingsOpen, setSettingsOpen] = useState(false)
  const readRequest = useRef<AbortController | null>(null)

  // 渐显是试样，用户可以关掉；关掉后这一封和以后的信都直接显示全文。
  useEffect(() => {
    try {
      setRevealOn(revealOnFrom(localStorage.getItem('e7-journal:reveal')))
      setSettingsOpen(settingsOpenFrom(localStorage.getItem('e7-journal:settings')))
    } catch {
      /* 存储不可用时保持默认：渐显开启、设置收起，不影响阅读 */
    }
  }, [])

  // 离开这一页或切换身份时，未完成的已读请求必须作废，旧响应不能回填新页面。
  useEffect(() => () => readRequest.current?.abort(), [])

  // 旅途：只读历史出行，失败单独重试，不牵连来往与礼物。
  useEffect(() => {
    const controller = new AbortController()
    setTripPhase('loading'); setTripError(''); setTrips([]); setOpenTrip(null); setDetail(null)
    void client.trips(dogId, controller.signal).then(result => {
      if (controller.signal.aborted) return
      setTrips(result.trips); setTripPhase('ready')
    }).catch(reason => {
      if (controller.signal.aborted) return
      setTripError(messageOf(reason)); setTripPhase('error')
    })
    return () => controller.abort()
  }, [dogId, client, revision, tripTick])

  // 这一趟的发现与归来话各自独立，一个失败不把另一个也标成空。
  useEffect(() => {
    if (!openTrip) { setDetail(null); return }
    const controller = new AbortController()
    // 同一趟重试保留已成功读取的内容，避免归来话失败把发现一起清空。
    setDetail(previous => previous?.tripId === openTrip && previous.phase === 'ready'
      ? { ...previous, retrying: true }
      : { tripId: openTrip, phase: 'loading', finds: [], message: null, findsError: '', messageError: '' })
    void Promise.allSettled([
      client.finds(openTrip, controller.signal),
      client.message(openTrip, controller.signal),
    ]).then(([findsResult, messageResult]) => {
      if (controller.signal.aborted) return
      setDetail(previous => settleTripDetail(openTrip, findsResult, messageResult, previous))
    })
    return () => controller.abort()
  }, [openTrip, client, detailTick])

  // 来往与礼物共用同一次信箱读取，避免同一接口打两遍；两侧各自标记失败。
  useEffect(() => {
    const controller = new AbortController()
    setMail({ ...EMPTY_MAIL })
    void Promise.allSettled([
      client.inbox(dogId, controller.signal),
      client.outbox(dogId, controller.signal),
    ]).then(([inboxResult, outboxResult]) => {
      if (controller.signal.aborted) return
      if (inboxResult.status === 'rejected' && outboxResult.status === 'rejected') {
        setMail({ ...EMPTY_MAIL, phase: 'error', inboxFailed: true, outboxFailed: true, error: messageOf(inboxResult.reason) })
        return
      }
      setMail({
        phase: 'ready',
        inbox: inboxResult.status === 'fulfilled' ? inboxResult.value.exchanges : [],
        outbox: outboxResult.status === 'fulfilled' ? outboxResult.value.exchanges : [],
        inboxFailed: inboxResult.status === 'rejected',
        outboxFailed: outboxResult.status === 'rejected',
        error: '',
      })
    })
    return () => controller.abort()
  }, [dogId, client, revision, mailTick])

  // 伙伴名与示例标记。读不到就如实说读不到，不编名字。
  useEffect(() => {
    const controller = new AbortController()
    setPeersUnavailable(false)
    void client.relations(dogId, controller.signal).then(result => {
      if (controller.signal.aborted) return
      setPeers(result.relations.filter(item => !item.relation.isBlocked).map(item => item.otherDog))
    }).catch(() => {
      if (controller.signal.aborted) return
      setPeers([]); setPeersUnavailable(true)
    })
    return () => controller.abort()
  }, [dogId, client])

  const entries = mergeExchanges(mail.inbox, mail.outbox, dogId)
  const unread = entries.filter(isNewIncoming).length
  const visibleLetters = correspondence(entries, mailDirection)
  const gifts = receivedGifts(mail.inbox, dogId)
  const openEntry = entries.find(item => item.exchange.id === openLetterId) ?? null
  const openBody = openEntry ? entryBody(openEntry) : null
  const openSource = openEntry && openEntry.exchange.payload.kind === 'find'
    ? safeSource(openEntry.exchange.payload.sourceUrl)
    : undefined
  // 只有「新到」那一封第一次打开时才渐显；已读回看、关掉开关、系统减少动效都直接给全文。
  const animateOpenLetter = Boolean(openEntry && revealId === openEntry.exchange.id && revealOn && !reducedMotion && !revealedNow)
  const canToggleReveal = Boolean(openEntry && openEntry.direction === 'in' && openEntry.exchange.deliveredAt !== null)

  function peerOf(item: Exchange): PublicDogSummary | undefined {
    const other = item.toDog === dogId ? item.fromDog : item.toDog
    return peers.find(peer => peer.id === other)
  }
  function peerLabel(item: Exchange): string {
    const peer = peerOf(item)
    if (!peer) return '伙伴身份信息暂未读到'
    return `${peer.name ?? '这位伙伴'}${peer.isSample ? ' · 示例伙伴' : ''}`
  }

  function selectTab(next: Tab) {
    setTab(next)
    setOpenTrip(null)
    closeLetter()
  }

  function toggleTrip(id: string) {
    setOpenTrip(current => (current === id ? null : id))
  }

  function closeLetter() {
    readRequest.current?.abort()
    setOpening(false); setOpenLetterId(null); setReadError(''); setReplying(false)
    setRevealId(null); setRevealedNow(false)
  }

  function toggleReveal() {
    const next = !revealOn
    setRevealOn(next)
    try {
      localStorage.setItem('e7-journal:reveal', next ? 'on' : 'off')
    } catch {
      /* 存储不可用时只在本次生效 */
    }
  }

  function toggleSettings() {
    const next = !settingsOpen
    setSettingsOpen(next)
    try {
      localStorage.setItem('e7-journal:settings', next ? 'open' : 'closed')
    } catch {
      /* 存储不可用时只在本次生效 */
    }
  }

  async function openLetter(entry: JournalEntry) {
    if (isSealed(entry)) return
    setOpenLetterId(entry.exchange.id); setReadError(''); setReplying(false)
    // 只有这一封在打开前还是「新到」才渐显；已读回看直接给全文。
    setRevealId(shouldRevealOnOpen(entry, { revealOn, reducedMotion }) ? entry.exchange.id : null)
    setRevealedNow(false)
    if (!shouldMarkRead(entry)) return
    const controller = new AbortController()
    readRequest.current?.abort(); readRequest.current = controller
    setOpening(true)
    try {
      const result = await client.read(entry.exchange.id, controller.signal)
      if (controller.signal.aborted) return
      setMail(previous => ({
        ...previous,
        inbox: previous.inbox.map(row => row.id === result.exchange.id ? result.exchange : row),
      }))
    } catch {
      if (!controller.signal.aborted) setReadError('内容已打开，但已读状态没保存。可以重新保存。')
    } finally {
      if (!controller.signal.aborted) setOpening(false)
    }
  }

  return <div className={s.page}>
    <header className={s.top}>
      <Link className={s.brand} href="/home">看山出门</Link>
      <Link className={s.back} href="/home">回小屋</Link>
    </header>
    <main id="content">
      {fixture && <p className={s.notice}>示例预览 · 这一页的出行、来信与礼物都是夹具，不会写入真实数据。</p>}
      <div className={s.heading}>
        <img className={s.headingIcon} src="/assets/a5-v25/home/journal.png" alt="" width="42" height="60" /><h1>手账</h1>
        <img className={s.cornerActor} src="/assets/a5-v25/head-success.png" alt="" width="72" height="59" />
        <p className={s.intro}>走过的路、收到的信，都留在这里。</p>
      </div>
      <nav className={s.tabs} aria-label="手账分类">
        {TABS.map(([key, label]) => <button key={key} aria-pressed={tab === key} onClick={() => selectTab(key)}>{label}{key === 'letters' && unread > 0 && <span className={s.badge} aria-label={`${unread} 条新到来信`}>{unread}</span>}</button>)}
      </nav>

      {tab === 'trips' && <section className={s.section} aria-label="旅途">
        {tripPhase === 'loading' && <p role="status" className={s.notice}>正在翻这一本手账…</p>}
        {tripPhase === 'error' && <Failure text={tripError} onRetry={() => setTripTick(x => x + 1)} />}
        {tripPhase === 'ready' && (trips.length === 0
          ? <Empty text="还没有出过门。等它第一次出发，这里就会记下第一页。" />
          : <div className={s.list}>{trips.map(trip => {
            const outcome = tripOutcome(trip)
            const expanded = openTrip === trip.id
            return <article className={s.card} key={trip.id}>
              <div className={s.cardHead}>
                <h2>{tripLabel(trip)}</h2>
                <span className={`${s.status} ${s[outcome.tone]}`}>{outcome.label}</span>
              </div>
              <p className={s.muted}>{formatTripMoment(trip) ?? '时间暂时读不到'}</p>
              {outcome.note && <p className={s.muted}>{outcome.note}</p>}
              <button onClick={() => toggleTrip(trip.id)} aria-expanded={expanded}>{expanded ? '收起这一趟' : '翻开这一趟'}</button>
              {expanded && <TripDetail detail={detail} onRetry={() => setDetailTick(x => x + 1)} />}
            </article>
          })}</div>)}
      </section>}

      {tab === 'letters' && <section className={s.section} aria-label="来往">
        <nav className={s.mailTabs} aria-label="收寄分类">
          <button aria-pressed={mailDirection === 'in'} onClick={() => { setMailDirection('in'); closeLetter() }}>收到{unread > 0 && <span className={s.badge} aria-label={`${unread} 条新到来信`}>{unread}</span>}</button>
          <button aria-pressed={mailDirection === 'out'} onClick={() => { setMailDirection('out'); closeLetter() }}>寄出</button>
        </nav>
        {mail.phase === 'loading' && <p role="status" className={s.notice}>正在整理收到的和寄出的…</p>}
        {mail.phase === 'error' && <Failure text={mail.error} onRetry={() => setMailTick(x => x + 1)} />}
        {mail.phase === 'ready' && <>
          {mail.inboxFailed && <p className={s.notice} role="status">收件暂时读不到，下面只有你寄出的部分。<button onClick={() => setMailTick(x => x + 1)}>重新读取</button></p>}
          {mail.outboxFailed && <p className={s.notice} role="status">发件暂时读不到，下面只有收到的部分。<button onClick={() => setMailTick(x => x + 1)}>重新读取</button></p>}
          {peersUnavailable && <p className={s.muted}>伙伴身份暂时读不到，名字与示例标记无法显示。内容本身不受影响。</p>}
          {!openEntry && (visibleLetters.length === 0
            ? <Empty text="这一栏还安静着。有了新的来往，再来翻翻。" />
            : <div className={s.list}>{visibleLetters.map((entry, index) => {
              const sealed = isSealed(entry)
              const inbound = entry.direction === 'in'
              const body = entryBody(entry)
              const fresh = isNewIncoming(entry)
              const pending = entry.exchange.deliveredAt === null
              const groupStart = index === 0 || pending !== (visibleLetters[index - 1].exchange.deliveredAt === null)
              return <div key={entry.exchange.id}>
                {groupStart && <h2 className={s.groupHeading}>{pending ? '在路上' : inbound ? '收到的信' : '寄出的信'}</h2>}
                <article className={`${s.card} ${s.letterCard} ${fresh ? s.freshCard : ''}`}>
                <img className={s.mailIcon} src="/assets/a5-v25/home/mail.png" alt="" width="48" height="38" />
                <p className={s.muted}>{inbound ? '收到' : '寄出'} · {peerLabel(entry.exchange)}</p>
                <div className={s.cardHead}>
                  <h2>{letterTitle(entry.exchange, dogId)}</h2>
                  <span className={`${s.status} ${fresh ? s.freshStatus : ''}`}>{fresh && <span aria-hidden="true">● </span>}{journalLetterState(entry)}</span>
                </div>
                {sealed && <p className={s.muted}>伙伴下次出行开始时，才会带来。不用守着等。</p>}
                {!inbound && body !== null && <p className={s.text}>{body || '这份心意没有附言。'}</p>}
                {!inbound && <p className={s.muted}>{entry.exchange.deliveredAt ? '已经送达。不必等对方马上回应。' : '已交给伙伴，尚未送达。'}</p>}
                {inbound && !sealed && <button onClick={() => void openLetter(entry)}>拆开看看</button>}
              </article></div>
            })}</div>)}

          {openEntry && <section className={s.paper} aria-label="这一封的内容">
            <h2>{letterTitle(openEntry.exchange, dogId)}</h2>
            <p className={s.muted}>{peerLabel(openEntry.exchange)}</p>
            {peerOf(openEntry.exchange)?.isSample && <p className={s.notice}>这是一位示例伙伴，可能不会回话。</p>}
            {animateOpenLetter && openBody
              ? <StaggerText text={openBody} onReveal={() => setRevealedNow(true)} />
              : <p className={s.text}>{openBody || '这份心意没有附言。'}</p>}
            {sourceNote(openEntry) && <p className={s.muted}>{sourceNote(openEntry)}</p>}
            {openSource && <a href={openSource} target="_blank" rel="noopener noreferrer">阅读原文</a>}
            {opening && <p role="status">正在保存已读状态…</p>}
            {readError && <p role="alert">{readError} <button onClick={() => void openLetter(openEntry)}>重新保存已读</button></p>}
            <p className={s.muted}>不用现在回应。这封信会安静地留在这里。</p>
            <div className={s.actions}>
              {!openEntry.exchange.repliedAt && <button onClick={() => setReplying(!replying)} aria-expanded={replying}>留个回应</button>}
              <button onClick={closeLetter}>收好，回到这一页</button>
              {canToggleReveal && <button onClick={toggleSettings} aria-expanded={settingsOpen}>阅读设置</button>}
            </div>
            {canToggleReveal && settingsOpen && <section id="e7-reading-settings" className={s.settings} aria-label="阅读设置">
              <p className={s.muted}>新到的信第一次打开时，文字会一个字一个字出现。点正文可以立即显示全文。</p>
              {reducedMotion
                ? <p className={s.muted}>系统已开启「减少动态效果」，这一封直接显示全文。</p>
                : <button onClick={toggleReveal}>{revealOn ? '关掉逐字渐显' : '打开逐字渐显'}</button>}
            </section>}
            {replying && (renderReply
              ? renderReply({ exchangeId: openEntry.exchange.id }, () => { setReplying(false); closeLetter(); setMailTick(x => x + 1) }, () => setReplying(false))
              : <p className={s.notice}>回应模块尚未接入，这封信仍可继续阅读。</p>)}
          </section>}
        </>}
      </section>}

      {tab === 'gifts' && <section className={s.section} aria-label="收到的礼物">
        {mail.phase === 'loading' && <p role="status" className={s.notice}>正在看有没有还没拆的礼物…</p>}
        {mail.phase === 'error' && <Failure text={mail.error} onRetry={() => setMailTick(x => x + 1)} />}
        {mail.phase === 'ready' && mail.inboxFailed && <Failure text="收件暂时读不到，礼物也一起看不到。" onRetry={() => setMailTick(x => x + 1)} />}
        {mail.phase === 'ready' && !mail.inboxFailed && (gifts.length === 0
          ? <Empty text="还没有收到礼物。以后会有的。" />
          : <div className={s.list}>{gifts.map(item => <article className={s.card} key={item.id}>
            <div className={s.cardHead}>
              <h2>{item.payload.kind === 'gift' ? item.payload.giftName : '一份礼物'}</h2>
              <span className={s.status}>已收到</span>
            </div>
            <p className={s.muted}>{peerLabel(item)}</p>
            <div className={s.giftArt}>
              <img src={item.payload.kind === 'gift' ? giftThumbnail(item.payload.imagePath) ?? '/assets/a5-v25/home/pouch.png' : '/assets/a5-v25/home/pouch.png'} alt="" width="68" height="80" />
              {item.payload.kind === 'gift' && !giftThumbnail(item.payload.imagePath) && <span className={s.muted}>礼物示意</span>}
            </div>
            {item.payload.kind === 'gift' && item.payload.note && <p className={s.text}>{item.payload.note}</p>}
            <p className={s.muted}>{item.payload.kind === 'gift' ? provenanceNote(item.payload.sourceMode) : '来源信息未提供'}</p>
          </article>)}</div>)}
      </section>}
    </main>
  </div>
}

/**
 * 逐字渐显试样：只动透明度，不加模糊，避免像素字发虚和额外的性能负担。
 * 只处理第一行、且不超过 60 字的「短首段」，其余文字直接显示；
 * 点一下立即显示全文；屏幕阅读器读的是完整原文，不逐字播报。
 */
function StaggerText({ text, onReveal }: { text: string; onReveal: () => void }) {
  const head = revealHead(text)
  return <p className={s.text} aria-label={text} title="点一下直接显示全文">
    <span className={s.reveal} aria-hidden="true" onClick={onReveal}>
      {head
        ? <>
          {[...head].map((char, index) => (
            <span key={index} className={s.glyph} style={{ animationDelay: `${glyphDelayMs(index)}ms`, animationDuration: `${GLYPH_FADE_MS}ms` }}>{char}</span>
          ))}
          {text.slice(head.length)}
        </>
        : text}
    </span>
  </p>
}

function TripDetail({ detail, onRetry }: { detail: TripDetailState | null; onRetry: () => void }) {
  if (!detail) return <p role="status" className={s.notice}>正在读这一趟…</p>
  if (detail.phase === 'loading') return <p role="status" className={s.notice}>正在读这一趟…</p>
  if (detail.phase === 'error') return <Failure text="这一趟的记录暂时读不到。" onRetry={onRetry} />
  const place = tripPlace(detail.finds)
  const message = tripMessageText(detail.message)
  return <div className={s.detail}>
    <section className={s.returnNote} aria-label="归来话">
      <h3><img src="/assets/a5-v25/head-success.png" alt="" width="48" height="40" />看山回来说</h3>
    {detail.messageError
      ? <p className={s.muted}>归来话暂时读不到。<button disabled={detail.retrying} onClick={onRetry}>重新读取归来话</button></p>
      : message
        ? <blockquote className={s.quote}>{message}</blockquote>
        : <p className={s.muted}>这一趟没有留下归来话。</p>}
    </section>
    <h3 className={s.groupHeading}>这趟的发现</h3>
    {place && <p>去了 <strong>{place}</strong></p>}
    {detail.retrying && <p role="status" className={s.muted}>正在重新读取这一趟…</p>}
    {detail.findsError && <p className={s.muted}>这一趟的发现暂时读不到。<button disabled={detail.retrying} onClick={onRetry}>重新读取</button></p>}
    {detail.finds.length === 0
        ? !detail.findsError && <p className={s.muted}>这一趟没有记下发现。</p>
        : <>
          <p className={s.muted}>这一趟记下 {detail.finds.length} 条发现</p>
          <ul className={s.finds}>{detail.finds.map(find => <li key={find.id}>
            <strong>{find.title}</strong>
            <span className={s.muted}>{provenanceNote(find.sourceMode)}</span>
            {find.excerpt && <span className={s.text}>{find.excerpt}</span>}
            {find.kind === 'zhihu' && safeSource(find.sourceUrl) && <a href={safeSource(find.sourceUrl)} target="_blank" rel="noopener noreferrer">阅读原文</a>}
          </li>)}</ul>
        </>}

  </div>
}

function Failure({ text, onRetry }: { text: string; onRetry: () => void }) {
  return <div className={s.notice} role="alert"><p>{text}</p><button onClick={onRetry}>重新读取</button></div>
}

function Empty({ text }: { text: string }) {
  return <div className={s.empty}><div className={s.mark} aria-hidden="true" /><p>{text}</p></div>
}
