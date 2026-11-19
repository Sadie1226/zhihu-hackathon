// 目标位置：app/(b)/b4-panels.tsx
// 小屋左侧竖排入口：第 1 聊聊，第 2 心愿（a 的入口表定死，位置与文案不要改）。
// 形态是面板切换，不切页。a5 重写小屋时挂载本组件即可，不要往 a 的 HTML 里手插按钮。
'use client'

import { useState } from 'react'
import { ChatPanel } from './b4-chat-panel'
import { WishPanel } from './b4-wish-panel'
import styles from './b4-panel.module.css'

const ENTRIES = [
  { id: 'chat', label: '聊聊' },
  { id: 'wish', label: '心愿' },
] as const

type EntryId = (typeof ENTRIES)[number]['id']

export function B4Panels({ dogId = 'dog_owner' }: { dogId?: string }) {
  const [active, setActive] = useState<EntryId>('wish')

  return (
    <div className={styles.shell}>
      <nav className={styles.rail} aria-label="小屋功能">
        {ENTRIES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`${styles.railButton} ${active === entry.id ? styles.railButtonActive : ''}`}
            aria-pressed={active === entry.id}
            onClick={() => setActive(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      <div className={styles.stage} role="region" aria-live="polite">
        {active === 'wish' ? <WishPanel dogId={dogId} /> : <ChatPanel />}
      </div>
    </div>
  )
}
