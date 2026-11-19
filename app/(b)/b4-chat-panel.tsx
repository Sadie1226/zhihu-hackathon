// 目标位置：app/(b)/b4-chat-panel.tsx
// 日常交流（2.1）：闲聊说完就完，不落成长期任务。
'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import styles from './b4-panel.module.css'
import { sendChatFixture } from './b4-chat-fixture'

type Turn = {
  id: string
  who: 'dog' | 'owner'
  text: string
  pending?: boolean
}

export function ChatPanel() {
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

    const id = `owner_${Date.now()}`
    setTurns((previous) => [...previous, { id, who: 'owner', text: value, pending: true }])
    setText('')
    setNotice('')
    setSending(true)
    try {
      const reply = await sendChatFixture(value)
      setTurns((previous) => [
        ...previous.map((turn) =>
          turn.id === id ? { ...turn, pending: false } : turn,
        ),
        { id: `dog_${Date.now()}`, who: 'dog', text: reply },
      ])
    } catch {
      setNotice('这次没确认送出，可重试。')
    } finally {
      setSending(false)
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="b4-chat-title">
      <div className={styles.titleRow}>
        <h2 id="b4-chat-title" className={styles.title}>说说话</h2>
        <span className={styles.badge}>示例对话</span>
      </div>

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
                {turn.pending && <span className={styles.pending}>还没送到</span>}
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
          发送
        </button>
        <p className={styles.hint}>闲聊说完就完，不会记成任务。</p>
      </form>
    </section>
  )
}
