'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import dynamic from 'next/dynamic'
import type { JournalTab } from '@/components/e7/journal-view'
import s from './home-openings.module.css'

const MailboxContent = dynamic(() => import('@/components/e6/mailbox-page').then(module => module.MailboxContent), { loading: () => <p role="status">正在取出这一叠信…</p> })
const JournalContent = dynamic(() => import('@/components/e7/journal-page').then(module => module.JournalContent), { loading: () => <p role="status">正在翻这一本手账…</p> })

export type OpeningKind = 'mail' | 'journal'
type Props = {
  kind: OpeningKind
  reducedMotion: boolean
  onClose: () => void
  /** Only the development preview supplies fixture bodies. The real home never does. */
  renderMailbox?: (close: () => void) => ReactNode
  renderJournal?: (tab: JournalTab, directory: () => void) => ReactNode
}
const CHAPTERS = [
  ['trips', '旅途', '走过的路，慢慢翻回来。', '/assets/a5-v25/home/door.png'],
  ['letters', '来往', '收到的、寄出的，都留在这里。', '/assets/a5-v25/home/mail.png'],
  ['gifts', '收到的礼物', '伙伴捎来的小小心意。', '/assets/a5-v25/home/pouch.png'],
] as const

export function HomeOpenings({ kind, reducedMotion, onClose, renderMailbox, renderJournal }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [opening, setOpening] = useState(!reducedMotion)
  const [chapter, setChapter] = useState<JournalTab | null>(null)
  const finish = useCallback(() => setOpening(false), [])

  useEffect(() => {
    const target = dialog.current
    if (!target) return
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    target.showModal()
    return () => {
      target.close()
      document.body.style.overflow = previousOverflow
      if (trigger?.isConnected) trigger.focus()
    }
  }, [])
  useEffect(() => {
    if (!opening) return
    if (reducedMotion) { finish(); return }
    // Never make reading depend on a stalled/unsupported decorative video.
    const timer = setTimeout(finish, kind === 'mail' ? 720 : 2400)
    return () => clearTimeout(timer)
  }, [opening, reducedMotion, kind, finish])
  useEffect(() => {
    const target = video.current
    if (!target || !opening || reducedMotion) return
    void target.play().catch(finish)
    return () => target.pause()
  }, [opening, reducedMotion, finish])

  if (typeof document === 'undefined') return null
  return createPortal(<dialog ref={dialog} className={s.dialog} aria-labelledby="e10-opening-title"
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => {
      if (event.target !== event.currentTarget) return
      const rect = event.currentTarget.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose()
    }}>
    <div className={s.bar}>
      <h2 id="e10-opening-title">{kind === 'mail' ? '小屋来信' : '小屋手账'}</h2>
      <button type="button" onClick={onClose} aria-label="关闭，回到小屋">回小屋 ×</button>
    </div>
    {opening ? <div className={s.opening}>
      {kind === 'journal'
        ? <video ref={video} className={s.video} src="/assets/e10-openings/journal-open.mp4" poster="/assets/e10-openings/journal-closed.png"
            width="640" height="640" autoPlay muted playsInline preload="none" aria-hidden="true" onEnded={finish} onError={finish} />
        : <div className={s.envelope} aria-hidden="true">
            <span className={s.paperLeft} /><span className={s.paperMiddle} /><span className={s.paperRight} />
            <img src="/assets/a5-v25/home/mail.png" width="240" height="186" alt="" />
          </div>}
      <p role="status">{kind === 'mail' ? '轻轻打开信封…' : '翻开这一本手账…'}</p>
      <button type="button" onClick={finish}>跳过动画，直接打开</button>
    </div> : kind === 'mail'
      ? <div className={s.content}>{renderMailbox ? renderMailbox(onClose) : <MailboxContent embedded onBack={onClose} />}</div>
      : chapter === null
        ? <div className={s.directory}>
            <img className={s.book} src="/assets/e10-openings/journal-open.png" alt="展开的蓝色像素手账" width="256" height="256" />
            <div><p className={s.eyebrow}>翻到哪一页，都可以。</p><h3>手账目录</h3>
              <nav aria-label="手账目录">{CHAPTERS.map(([key, label, note, icon]) => <button type="button" key={key} onClick={() => setChapter(key)}>
                <img src={icon} width="42" height="42" alt="" /><span><strong>{label}</strong><small>{note}</small></span><span aria-hidden="true">→</span>
              </button>)}</nav>
            </div>
          </div>
        : <div className={`${s.content} ${reducedMotion ? '' : s.turnPage}`} key={chapter}>
            {renderJournal ? renderJournal(chapter, () => setChapter(null)) : <JournalContent embedded initialTab={chapter} onBack={() => setChapter(null)} />}
          </div>}
  </dialog>, document.body)
}
