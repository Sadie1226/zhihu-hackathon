// 目标位置：app/(b)/b4-invitations.tsx
// 归来区邀请正文，按 A 的 ShellBindings.Invitations 签名导出；origin 只是页面上下文。
// A 评审 v2 §2：压缩/取消上传、上传与回应失败分态、已上传 URL 保留重试、真实空态分离。
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { InvitationView, Reply } from '@/contracts/types'
import type { InvitationPanelProps } from './b4-ports'
import { compressImageFile } from './b4-photo-client'
import styles from './b4-panel.module.css'

type Phase = 'loading' | 'ready' | 'failed' | 'unauthorized'
/** 单条邀请的提交阶段：上传与回应各自独立，错误可分别提示与重试。 */
type SendPhase = 'idle' | 'compressing' | 'uploading' | 'replying'
type Draft = {
  text: string
  file: File | null
  /** 上传成功后按邀请 id 保留；回应失败重试时直接用它，不重传同一张图。 */
  uploadedUrl: string | null
  phase: SendPhase
  uploadError: string
  replyError: string
}

function emptyDraft(): Draft {
  return {
    text: '', file: null, uploadedUrl: null,
    phase: 'idle', uploadError: '', replyError: '',
  }
}

function readableUploadError(status: number): string {
  if (status === 413) return '图没传上去：图片太大或边长超过 1600，换张小一点的。'
  if (status === 415) return '图没传上去：这张图打不开或不是支持的格式。'
  if (status === 401 || status === 403) return '图没传上去：会话失效了，请返回后重试。'
  return '图没传上去：这次没连上，可以再试一次。'
}

function readableReplyError(status: number): string {
  if (status === 401 || status === 403 || status === 404) return '回应没成功：这只狗不在当前会话里了。'
  return '这次没回应成功，文字和图都还在，可以再试一次。'
}

export function Invitations({ dogId, tripId, origin, returnTo }: InvitationPanelProps) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [rows, setRows] = useState<InvitationView[]>([])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set())
  const [notice, setNotice] = useState('')
  const requestRef = useRef<AbortController | null>(null)
  /** 每条邀请一个上传控制器，取消只影响这一条，不动列表 GET。 */
  const uploadRefs = useRef<Record<string, AbortController>>({})
  const generationRef = useRef(0)

  const draftOf = useCallback((id: string): Draft => drafts[id] ?? emptyDraft(), [drafts])
  const patchDraft = useCallback((id: string, patch: Partial<Draft>) => {
    setDrafts((previous) => ({ ...previous, [id]: { ...(previous[id] ?? emptyDraft()), ...patch } }))
  }, [])

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
      Object.values(uploadRefs.current).forEach((controller) => controller.abort())
    }
  }, [load])

  function cancelUpload(invitationId: string) {
    uploadRefs.current[invitationId]?.abort()
    delete uploadRefs.current[invitationId]
    patchDraft(invitationId, { phase: 'idle', uploadError: '' })
    setNotice('已取消上传，这张图没有送出去。')
  }

  function clearPhoto(invitationId: string) {
    // 更换/清除照片才让已上传 URL 失效。
    patchDraft(invitationId, {
      file: null, uploadedUrl: null, uploadError: '', phase: 'idle',
    })
  }

  async function respond(invitation: InvitationView) {
    const id = invitation.id
    if (busyIds.has(id)) return
    if (phase !== 'ready') {
      setNotice('读取还没成功，请先再试一次。')
      return
    }
    const draft = draftOf(id)
    const text = draft.text.trim()
    if (!text && !draft.file && !draft.uploadedUrl) {
      setNotice('文字和照片至少给一个。')
      return
    }

    setBusyIds((previous) => new Set(previous).add(id))
    setNotice('')
    try {
      let photoUrl = draft.uploadedUrl

      // 阶段一：有未上传的文件就先压缩→上传；失败只写 uploadError，不冒充回应失败。
      if (draft.file && !photoUrl) {
        patchDraft(id, { phase: 'compressing', uploadError: '', replyError: '' })
        let uploadFile: File
        try {
          uploadFile = await compressImageFile(draft.file)
        } catch {
          patchDraft(id, { phase: 'idle', uploadError: '图没传上去：这张图打不开，换一张试试。' })
          return
        }
        const controller = new AbortController()
        uploadRefs.current[id] = controller
        patchDraft(id, { phase: 'uploading' })
        let url: string
        try {
          const form = new FormData()
          form.append('file', uploadFile)
          const uploadResponse = await fetch('/api/uploads/photo', {
            method: 'POST', body: form, credentials: 'same-origin', signal: controller.signal,
          })
          if (!uploadResponse.ok) {
            patchDraft(id, { phase: 'idle', uploadError: readableUploadError(uploadResponse.status) })
            return
          }
          const uploaded = (await uploadResponse.json()) as { url: string }
          url = uploaded.url
          // 成功即按邀请保留 URL；之后回应失败重试不再重传这张图。
          patchDraft(id, { phase: 'idle', uploadedUrl: url })
        } catch {
          if (controller.signal.aborted) {
            patchDraft(id, { phase: 'idle' })
            setNotice('已取消上传，这张图没有送出去。')
            return
          }
          patchDraft(id, { phase: 'idle', uploadError: '图没传上去：这次没连上，可以再试一次。' })
          return
        } finally {
          delete uploadRefs.current[id]
        }
        photoUrl = url
      }

      // 阶段二：提交回应；失败只写 replyError，已上传 URL 与原文都保留供重试。
      patchDraft(id, { phase: 'replying', replyError: '' })
      const body: Record<string, string> = { invitationId: id }
      if (text) body.text = text
      if (photoUrl) body.photoUrl = photoUrl
      const response = await fetch('/api/replies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        patchDraft(id, { phase: 'idle', replyError: readableReplyError(response.status) })
        return
      }
      const data = (await response.json()) as { reply: Reply }
      setRows((previous) => previous.map((item) => (
        item.id === id ? { ...item, state: 'replied', replyId: data.reply.id } : item
      )))
      setDrafts((previous) => {
        const next = { ...previous }
        delete next[id]
        return next
      })
    } catch {
      // 网络完全不可用：不承诺即时送达，保留原文与已上传图，明确可重试。
      patchDraft(id, { phase: 'idle', replyError: '这次没回应成功，文字和图都还在，可以再试一次。' })
    } finally {
      setBusyIds((previous) => {
        const next = new Set(previous)
        next.delete(id)
        return next
      })
    }
  }

  const waiting = rows.filter((row) => row.state === 'waiting')
  const lastHandled = phase === 'ready' && rows.length > 0 && waiting.length === 0

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

      {/* 只有 phase=ready 才谈"有没有待回应邀请"；失败/未授权各自显示，不冒充空态。 */}
      {phase === 'loading' ? (
        <div aria-label="正在读取"><div className={styles.skeleton} /></div>
      ) : phase === 'failed' ? (
        <p className={styles.empty} role="alert">这次没读出来，点上面的「再试一次」。</p>
      ) : phase === 'unauthorized' ? (
        <p className={styles.empty}>这只狗不在当前会话里。<a className={styles.linkButton} href={returnTo}>返回原处</a></p>
      ) : waiting.length === 0 ? (
        <p className={styles.empty}>
          {lastHandled ? '这一条已经回过了，这里暂时没有别的邀请。' : '它这会儿没有需要回应的邀请。'}
        </p>
      ) : (
        <ul className={styles.list}>
          {waiting.map((invitation) => {
            const draft = draftOf(invitation.id)
            const busy = busyIds.has(invitation.id)
            const sending = draft.phase !== 'idle'
            const sendLabel = draft.phase === 'compressing' ? '正在压缩图片…'
              : draft.phase === 'uploading' ? '正在传图…'
                : draft.phase === 'replying' ? '正在回应…' : '回一句'
            return (
              <li key={invitation.id} className={styles.inviteCard}>
                <span className={styles.itemText}>{invitation.text}</span>
                <label htmlFor={`b4-reply-${invitation.id}`}>回一句（≤200 字）</label>
                <textarea
                  id={`b4-reply-${invitation.id}`}
                  className={styles.textarea}
                  maxLength={200}
                  value={draft.text}
                  disabled={busy || sending}
                  onChange={(event) => patchDraft(invitation.id, { text: event.target.value })}
                />
                <input
                  className={styles.fileInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={busy || sending}
                  onChange={(event) => patchDraft(invitation.id, {
                    file: event.target.files?.[0] ?? null,
                    uploadedUrl: null, // 换图即让旧 URL 失效
                    uploadError: '',
                  })}
                />
                {(draft.file || draft.uploadedUrl) && (
                  <div className={styles.row}>
                    <span className={styles.hint}>
                      {draft.uploadedUrl ? '图片已上传，可随回应一起送出' : `已选择：${draft.file?.name ?? ''}（发送前会先压缩）`}
                    </span>
                    <button
                      type="button"
                      className={styles.ghostButton}
                      disabled={busy || sending}
                      onClick={() => clearPhoto(invitation.id)}
                    >
                      清除照片
                    </button>
                  </div>
                )}
                {draft.uploadError && (
                  <p className={styles.errorText} role="alert">
                    {draft.uploadError}
                    <button
                      type="button"
                      className={styles.ghostButton}
                      disabled={busy || sending}
                      onClick={() => void respond(invitation)}
                    >
                      重试
                    </button>
                  </p>
                )}
                {draft.replyError && (
                  <p className={styles.errorText} role="alert">
                    {draft.replyError}
                    <button
                      type="button"
                      className={styles.ghostButton}
                      disabled={busy || sending}
                      onClick={() => void respond(invitation)}
                    >
                      重试
                    </button>
                  </p>
                )}
                <div className={styles.row}>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    disabled={busy || sending}
                    onClick={() => void respond(invitation)}
                  >
                    {sendLabel}
                  </button>
                  {draft.phase === 'uploading' && (
                    <button
                      type="button"
                      className={styles.ghostButton}
                      onClick={() => cancelUpload(invitation.id)}
                    >
                      取消上传
                    </button>
                  )}
                  <a className={styles.linkButton} href={returnTo}>先不回</a>
                </div>
                <p className={styles.hint}>邀请会一直留着，这里不催你。</p>
              </li>
            )
          })}
        </ul>
      )}

      <a className={styles.linkButton} href={returnTo}>返回原处</a>
    </section>
  )
}
