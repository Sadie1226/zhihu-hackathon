// 目标位置：app/(b)/b4-wish-panel.tsx
// 心愿面板：弹面板，不切页。四态齐全；fixture 显形，不冒称 live。
'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  INTEREST_CATEGORIES,
  type InterestCategory,
  type Wish,
} from '@/contracts/types'
import wishFixture from '@/contracts/fixtures/wish.json'
import styles from './b4-panel.module.css'

type Phase = 'loading' | 'ready'
type Mode = 'live' | 'fixture'

const fixtureWishes: Wish[] = wishFixture.wishes
  .map((row) => ({
    id: row.id,
    dogId: row.dog_id,
    text: row.text,
    category: row.category as InterestCategory,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  }))
  .filter((wish) => wish.revokedAt === null)

function charCount(value: string): number {
  return Array.from(value).length
}

export function WishPanel({ dogId }: { dogId: string }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [mode, setMode] = useState<Mode>('live')
  const [wishes, setWishes] = useState<Wish[]>([])
  const [text, setText] = useState('')
  const [category, setCategory] = useState<InterestCategory>(INTEREST_CATEGORIES[0])
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setPhase('loading')
    setNotice('')
    try {
      const response = await fetch(
        `/api/dogs/${encodeURIComponent(dogId)}/wishes?includeRevoked=false`,
        { cache: 'no-store', credentials: 'same-origin' },
      )
      if (!response.ok) throw new Error('request failed')
      const data = (await response.json()) as { wishes: Wish[] }
      setWishes(data.wishes)
      setMode('live')
    } catch {
      setWishes(fixtureWishes)
      setMode('fixture')
      setNotice('这次没读出来。下面是示例，操作不会保存。')
    } finally {
      setPhase('ready')
    }
  }, [dogId])

  useEffect(() => {
    void load()
  }, [load])

  async function addWish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = text.trim()
    if (charCount(value) < 1 || charCount(value) > 200) {
      setNotice('心愿请写 1 到 200 字。')
      return
    }
    if (mode === 'fixture') {
      setWishes((previous) => [
        {
          id: `fixture_${Date.now()}`,
          dogId,
          text: value,
          category,
          createdAt: new Date().toISOString(),
          revokedAt: null,
        },
        ...previous,
      ])
      setText('')
      return
    }
    setBusy(true)
    setNotice('')
    try {
      const response = await fetch(
        `/api/dogs/${encodeURIComponent(dogId)}/wishes`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ text: value, category }),
        },
      )
      if (!response.ok) throw new Error('request failed')
      const data = (await response.json()) as { wish: Wish }
      setWishes((previous) => [
        data.wish,
        ...previous.filter((wish) => wish.id !== data.wish.id),
      ])
      setText('')
    } catch {
      setNotice('这次没记下，输入还在，可以再试一次。')
    } finally {
      setBusy(false)
    }
  }

  async function revokeWish(wish: Wish) {
    if (mode === 'fixture') {
      setWishes((previous) => previous.filter((item) => item.id !== wish.id))
      return
    }
    const before = wishes
    setWishes((previous) => previous.filter((item) => item.id !== wish.id))
    try {
      const response = await fetch(
        `/api/wishes/${encodeURIComponent(wish.id)}/revoke`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: '{}',
        },
      )
      if (!response.ok) throw new Error('request failed')
      // 不把结果重新插回生效列表：撤销是软删除，服务端也不回已撤销的详情。
    } catch {
      setWishes(before)
      setNotice('这次没撤销成功，可以再试一次。')
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="b4-wish-title">
      <div className={styles.titleRow}>
        <h2 id="b4-wish-title" className={styles.title}>心愿</h2>
        {mode === 'fixture' && <span className={styles.badge}>示例</span>}
      </div>

      {notice && (
        <p className={styles.notice} role="status">
          {notice}
          {mode === 'fixture' && (
            <button type="button" className={styles.ghostButton} onClick={() => void load()}>
              再试一次
            </button>
          )}
        </p>
      )}

      {phase === 'loading' ? (
        <div aria-label="正在读取">
          <div className={styles.skeleton} />
          <div className={styles.skeleton} />
        </div>
      ) : wishes.length === 0 ? (
        <p className={styles.empty}>还没告诉它想看什么。</p>
      ) : (
        <ul className={styles.list}>
          {wishes.map((wish) => (
            <li key={wish.id} className={styles.item}>
              <span className={styles.itemText}>{wish.text}</span>
              <span className={styles.chip}>{wish.category}</span>
              <button
                type="button"
                className={styles.ghostButton}
                onClick={() => void revokeWish(wish)}
                aria-label={`撤销心愿：${wish.text}`}
              >
                撤销
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className={styles.form} onSubmit={(event) => void addWish(event)}>
        <label htmlFor="b4-wish-text">想看什么……</label>
        <textarea
          id="b4-wish-text"
          className={styles.textarea}
          value={text}
          maxLength={200}
          onChange={(event) => setText(event.target.value)}
          placeholder="想看什么……"
        />
        <div className={styles.row}>
          <label htmlFor="b4-wish-category">类目</label>
          <select
            id="b4-wish-category"
            className={styles.select}
            value={category}
            onChange={(event) => setCategory(event.target.value as InterestCategory)}
          >
            {INTEREST_CATEGORIES.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          <span className={styles.counter}>{charCount(text)}/200</span>
        </div>
        <button type="submit" className={styles.primaryButton} disabled={busy}>
          记下心愿
        </button>
      </form>
    </section>
  )
}
