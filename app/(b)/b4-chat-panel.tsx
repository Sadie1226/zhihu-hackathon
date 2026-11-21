// 目标位置：app/(b)/b4-chat-panel.tsx
// 日常交流正文。POST /api/chat 未定契约，这里是显式示例通道，不是失败后的假成功降级。
'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { sendChatFixture } from './b4-chat-fixture'
import type { PanelContext } from './b4-ports'
import styles from './b4-panel.module.css'

type Turn = {
  id: string
  who: 'dog' | 'owner'
  text: string
  pending?: boolean
}

export function ChatPanel({ reducedMotion }: PanelContext) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [turns])

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = text.trim()
    if (value.length === 0 || sending) return

    setNotice('')
    const id = `owner_${Date.now()}`
    setTurns((previous) => [...previous, { id, who: 'owner', text: value, pending: true }])
    setText('')
    setSending(true)
    try {
      const reply = await sendChatFixture(value)
      setTurns((previous) => [
        ...previous.map((turn) => (turn.id === id ? { ...turn, pending: false } : turn)),
        { id: `dog_${Date.now()}`, who: 'dog', text: reply },
      ])
    } catch {
      // 示例通道自身出错时保留原文，不声称已送达。
      setText(value)
      setNotice('示例没能生成，原文还在，可以再试一次。')
    } finally {
      setSending(false)
    }
  }

  return (
    <section
      className={styles.panel}
      aria-label="聊聊"
      data-reduced-motion={reducedMotion ? 'true' : undefined}
    >
      <p className={styles.notice}>本机示例，不会送出，也不会记成任务。</p>
      {notice && <p className={styles.notice} role="status">{notice}</p>}

      {turns.length === 0 ? (
        <p className={styles.empty}>它还没说过话。</p>
      ) : (
        <div className={styles.thread} aria-live="polite">
          {turns.map((turn) => (
            <div
              key={turn.id}
              className={`${styles.bubbleRow} ${turn.who === 'owner' ? styles.bubbleRowOwner : ''}`}
            >
              <div>
                <div
                  className={`${styles.bubble} ${turn.who === 'owner' ? styles.bubbleOwner : styles.bubbleDog}`}
                >
                  {turn.text}
                </div>
                {turn.pending && <span className={styles.pending}>示例生成中</span>}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}

      <form className={styles.form} onSubmit={(event) => void send(event)}>
        <label htmlFor="b4-chat-text">想说什么……</label>
        <textarea
          id="b4-chat-text"
          className={styles.textarea}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="想说什么……"
        />
        <button type="submit" className={styles.primaryButton} disabled={sending}>
          发一条（示例）
        </button>
        <p className={styles.hint}>闲聊说完就完，不会记成任务。</p>
      </form>
    </section>
  )
}
