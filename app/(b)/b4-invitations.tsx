// 目标位置：app/(b)/b4-invitations.tsx
// 归来区邀请正文，按 A 的 ShellBindings.Invitations 签名导出；origin 只是页面上下文。
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { InvitationView, Reply } from '@/contracts/types'
import type { InvitationPanelProps } from './b4-ports'
import styles from './b4-panel.module.css'

type Phase = 'loading' | 'ready' | 'failed' | 'unauthorized'

async function uploadPhoto(file: File): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch('/api/uploads/photo', {
    method: 'POST',
    body: form,
    credentials: 'same-origin',
  })
  if (!response.ok) throw new Error('upload failed')
  const data = (await response.json()) as { url: string }
  return data.url
}

export function Invitations({ dogId, tripId, origin, returnTo }: InvitationPanelProps) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [rows, setRows] = useState<InvitationView[]>([])
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [files, setFiles] = useState<Record<string, File | null>>({})
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set())
  const [notice, setNotice] = useState('')
  const requestRef = useRef<AbortController | null>(null)
  const generationRef = useRef(0)

  const load = useCallback(async () => {
    const generation = ++generationRef.current
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setNotice('')
    setRows([])
    setPhase('loading')
    try {
      const response = await fetch(
        `/api/dogs/${encodeURIComponent(dogId)}/invitations`,
        { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' },
      )
      if (controller.signal.aborted || generation !== generationRef.current) return
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        setPhase('unauthorized')
        setNotice('这只狗不在当前会话里。')
        return
      }
      if (!response.ok) {
        setPhase('failed')
        setNotice('这次没读出来，可以再试一次。')
        return
      }
      const data = (await response.json()) as { invitations: InvitationView[] }
      if (controller.signal.aborted || generation !== generationRef.current) return
      setRows(data.invitations)
      setPhase('ready')
    } catch {
      if (controller.signal.aborted || generation !== generationRef.current) return
      setPhase('failed')
      setNotice('这次没读出来，可以再试一次。')
    }
  }, [dogId])

  useEffect(() => {
    void load()
    return () => {
      generationRef.current += 1
      requestRef.current?.abort()
    }
  }, [load])

  async function respond(invitation: InvitationView) {
    if (busyIds.has(invitation.id)) return
    if (phase !== 'ready') {
      setNotice('读取还没成功，请先再试一次。')
      return
    }
    const text = (texts[invitation.id] ?? '').trim()
    const file = files[invitation.id] ?? null
    if (!text && !file) {
      setNotice('文字和照片至少给一个。')
      return
    }

    setBusyIds((previous) => new Set(previous).add(invitation.id))
    setNotice('')
    try {
      const photoUrl = file ? await uploadPhoto(file) : undefined
      const body: Record<string, string> = { invitationId: invitation.id }
      if (text) body.text = text
      if (photoUrl) body.photoUrl = photoUrl
      const response = await fetch('/api/replies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        setNotice('这次没回应成功，输入还在。')
        return
      }
      const data = (await response.json()) as { reply: Reply }
      setRows((previous) => previous.map((item) => (
        item.id === invitation.id
          ? { ...item, state: 'replied', replyId: data.reply.id }
          : item
      )))
      setTexts((previous) => {
        const next = { ...previous }
        delete next[invitation.id]
        return next
      })
      setFiles((previous) => {
        const next = { ...previous }
        delete next[invitation.id]
        return next
      })
    } catch {
      setNotice('这次没回应成功，输入还在。')
    } finally {
      setBusyIds((previous) => {
        const next = new Set(previous)
        next.delete(invitation.id)
        return next
      })
    }
  }

  const waiting = rows.filter((row) => row.state === 'waiting')

  return (
    <section
      className={styles.panel}
      aria-label="来自它的邀请"
      data-trip-id={tripId}
      data-origin={origin}
    >
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
          {phase === 'failed' && (
            <button type="button" className={styles.ghostButton} onClick={() => void load()}>
              再试一次
            </button>
          )}
        </p>
      )}

      {phase === 'loading' ? (
        <div aria-label="正在读取"><div className={styles.skeleton} /></div>
      ) : waiting.length === 0 ? (
        <p className={styles.empty}>它在等你回一句话。</p>
      ) : (
        <ul className={styles.list}>
          {waiting.map((invitation) => (
            <li key={invitation.id} className={styles.inviteCard}>
              <span className={styles.itemText}>{invitation.text}</span>
              <label htmlFor={`b4-reply-${invitation.id}`}>回一句（≤200 字）</label>
              <textarea
                id={`b4-reply-${invitation.id}`}
                className={styles.textarea}
                maxLength={200}
                value={texts[invitation.id] ?? ''}
                disabled={busyIds.has(invitation.id)}
                onChange={(event) => setTexts((previous) => ({
                  ...previous, [invitation.id]: event.target.value,
                }))}
              />
              <input
                className={styles.fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={busyIds.has(invitation.id)}
                onChange={(event) => setFiles((previous) => ({
                  ...previous, [invitation.id]: event.target.files?.[0] ?? null,
                }))}
              />
              <div className={styles.row}>
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={busyIds.has(invitation.id)}
                  onClick={() => void respond(invitation)}
                >
                  回一句
                </button>
                <a className={styles.linkButton} href={returnTo}>先不回</a>
              </div>
              <p className={styles.hint}>邀请会一直留着，这里不催你。</p>
            </li>
          ))}
        </ul>
      )}

      <a className={styles.linkButton} href={returnTo}>返回原处</a>
    </section>
  )
}
