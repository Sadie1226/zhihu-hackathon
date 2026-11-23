// 目标位置：app/(b)/b4-reply-body.tsx
// 可复用回应正文，按 A 的 ShellBindings.ReplyBody / ReplyBodyProps 导出。
// 旅途邀请、来信、手账共用这一套：target 二选一（invitation/exchange），origin 只是页面上下文。
// A 负责把本组件绑到 wiring 的 ReplyBody；B 不造宿主/wiring/导航/弹窗。
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Reply } from '@/contracts/types'
import type { ReplyBodyProps } from './b4-ports'
import { compressImageFile } from './b4-photo-client'
import { targetField, targetKey, readableUploadError, readableReplyError } from './b4-reply-body-utils'
import styles from './b4-panel.module.css'

type SendPhase = 'idle' | 'compressing' | 'uploading' | 'replying'
type Draft = {
  text: string
  file: File | null
  /** 上传成功后保留；回应失败重试直接用它，不重传同一张图。 */
  uploadedUrl: string | null
  phase: SendPhase
  uploadError: string
  replyError: string
}

function emptyDraft(): Draft {
  return { text: '', file: null, uploadedUrl: null, phase: 'idle', uploadError: '', replyError: '' }
}

export function ReplyBody({
  dogId, target, origin, returnTo, reducedMotion, active = true,
  onClose, onCommitted, onReplied,
}: ReplyBodyProps) {
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [done, setDone] = useState(false)
  const uploadRef = useRef<AbortController | null>(null)
  const aliveRef = useRef(true)

  const patch = useCallback((value: Partial<Draft>) => {
    setDraft((previous) => ({ ...previous, ...value }))
  }, [])

  // 狗/来源切换或被卸载时重建实例：停后台工作，旧响应不能回填新目标。
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      uploadRef.current?.abort()
    }
  }, [dogId, targetKey(target)])

  // 隐藏面板保留草稿，但停止后台工作；恢复 active 不自动重传。
  useEffect(() => {
    if (!active) uploadRef.current?.abort()
  }, [active])

  function cancelUpload() {
    uploadRef.current?.abort()
    uploadRef.current = null
    patch({ phase: 'idle', uploadError: '' })
  }

  function clearPhoto() {
    patch({ file: null, uploadedUrl: null, uploadError: '', phase: 'idle' })
  }

  async function submit() {
    if (done) return
    const text = draft.text.trim()
    if (!text && !draft.file && !draft.uploadedUrl) return
    let photoUrl = draft.uploadedUrl

    // 阶段一：有未上传文件先压缩→上传；失败只写 uploadError，不冒充回应失败。
    if (draft.file && !photoUrl) {
      patch({ phase: 'compressing', uploadError: '', replyError: '' })
      let uploadFile: File
      try {
        uploadFile = await compressImageFile(draft.file, reducedMotion ? 1280 : 1600)
      } catch {
        if (aliveRef.current) patch({ phase: 'idle', uploadError: '图没传上去：这张图打不开，换一张试试。' })
        return
      }
      const controller = new AbortController()
      uploadRef.current = controller
      patch({ phase: 'uploading' })
      try {
        const form = new FormData()
        form.append('file', uploadFile)
        const response = await fetch('/api/uploads/photo', {
          method: 'POST', body: form, credentials: 'same-origin', signal: controller.signal,
        })
        if (!aliveRef.current || controller.signal.aborted) return
        if (!response.ok) {
          patch({ phase: 'idle', uploadError: readableUploadError(response.status) })
          return
        }
        const uploaded = (await response.json()) as { url: string }
        // 成功即保留 URL；之后回应失败重试不再重传这张图。
        patch({ phase: 'idle', uploadedUrl: uploaded.url })
        photoUrl = uploaded.url
      } catch {
        if (!aliveRef.current || controller.signal.aborted) return
        patch({ phase: 'idle', uploadError: '图没传上去：这次没连上，可以再试一次。' })
        return
      } finally {
        if (uploadRef.current === controller) uploadRef.current = null
      }
    }

    // 阶段二：提交回应；失败只写 replyError，已上传 URL 与原文都保留供重试。
    patch({ phase: 'replying', replyError: '' })
    const body: Record<string, string> = { ...targetField(target) }
    if (text) body.text = text
    if (photoUrl) body.photoUrl = photoUrl
    try {
      const response = await fetch('/api/replies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      })
      if (!aliveRef.current) return
      if (!response.ok) {
        patch({ phase: 'idle', replyError: readableReplyError(response.status) })
        return
      }
      const data = (await response.json()) as { reply: Reply }
      setDone(true)
      setDraft(emptyDraft())
      onReplied?.(data.reply)
      onCommitted({
        resource: target.invitationId ? 'invitations' : 'exchanges',
        id: data.reply.id,
      })
    } catch {
      if (!aliveRef.current) return
      // 网络完全不可用：不承诺即时送达，保留原文与已上传图，明确可重试。
      patch({ phase: 'idle', replyError: '这次没回应成功，文字和图都还在，可以再试一次。' })
    }
  }

  const busy = draft.phase !== 'idle'
  const sendLabel = draft.phase === 'compressing' ? '正在压缩图片…'
    : draft.phase === 'uploading' ? '正在传图…'
      : draft.phase === 'replying' ? '正在回应…' : '回一句'
  const targetId = targetKey(target)

  return (
    <section className={styles.panel} aria-label="回应" data-origin={origin} data-target={targetId}>
      {done ? (
        <p className={styles.empty} role="status">
          已经记下了。
          <button type="button" className={styles.linkButton} onClick={onClose}>返回</button>
        </p>
      ) : (
        <div className={styles.form}>
          <label htmlFor={`b4-reply-${targetId}`}>回一句（≤200 字，文字或照片至少给一个）</label>
          <textarea
            id={`b4-reply-${targetId}`}
            className={styles.textarea}
            maxLength={200}
            value={draft.text}
            disabled={busy}
            onChange={(event) => patch({ text: event.target.value })}
          />
          <input
            className={styles.fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy}
            onChange={(event) => patch({
              file: event.target.files?.[0] ?? null,
              uploadedUrl: null,
              uploadError: '',
            })}
          />
          {(draft.file || draft.uploadedUrl) && (
            <div className={styles.row}>
              <span className={styles.hint}>
                {draft.uploadedUrl ? '图片已上传，可随回应一起送出'
                  : `已选择：${draft.file?.name ?? ''}（发送前会先压缩）`}
              </span>
              <button type="button" className={styles.ghostButton} disabled={busy} onClick={clearPhoto}>
                清除照片
              </button>
              {draft.phase === 'uploading' && (
                <button type="button" className={styles.ghostButton} onClick={cancelUpload}>取消上传</button>
              )}
            </div>
          )}
          {draft.uploadError && (
            <p className={styles.errorText} role="alert">
              {draft.uploadError}
              <button type="button" className={styles.ghostButton} disabled={busy} onClick={() => void submit()}>重试</button>
            </p>
          )}
          {draft.replyError && (
            <p className={styles.errorText} role="alert">
              {draft.replyError}
              <button type="button" className={styles.ghostButton} disabled={busy} onClick={() => void submit()}>重试</button>
            </p>
          )}
          <div className={styles.row}>
            <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void submit()}>
              {sendLabel}
            </button>
            <a className={styles.linkButton} href={returnTo}>返回原处</a>
          </div>
        </div>
      )}
    </section>
  )
}
