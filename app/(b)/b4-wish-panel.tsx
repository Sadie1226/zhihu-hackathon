// 目标位置：app/(b)/b4-wish-panel.tsx
// 心愿面板正文。标题/关闭/遮罩由 A 的宿主负责；本文件不建第二套导航，也不在失败时回退示例。
'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  INTEREST_CATEGORIES,
  type InterestCategory,
  type Wish,
} from '@/contracts/types'
import wishFixture from '@/contracts/fixtures/wish.json'
import type { PanelContext } from './b4-ports'
import styles from './b4-panel.module.css'

type Phase = 'loading' | 'ready' | 'failed' | 'unauthorized'
type Props = PanelContext & { demo?: boolean }

// fixture 只用于显式 demo=true；映射补齐 C wish v3 的 source / sourceUrl。
const fixtureWishes: Wish[] = wishFixture.wishes
  .map((row) => ({
    id: row.id,
    dogId: row.dog_id,
    text: row.text,
    category: row.category as InterestCategory,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    source: row.source as Wish['source'],
    sourceUrl: row.source_url,
  }))
  .filter((wish) => wish.revokedAt === null)

function charCount(value: string): number {
  return Array.from(value).length
}

function isForbidden(status: number): boolean {
  return status === 401 || status === 403 || status === 404
}

export function WishPanel({ dogId, reducedMotion, onCommitted, demo = false }: Props) {
  const [phase, setPhase] = useState<Phase>(demo ? 'ready' : 'loading')
  const [wishes, setWishes] = useState<Wish[]>(
    demo ? fixtureWishes.filter((wish) => wish.dogId === dogId) : [],
  )
  const [text, setText] = useState('')
  const [category, setCategory] = useState<InterestCategory>(INTEREST_CATEGORIES[0])
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set())
  const requestRef = useRef<AbortController | null>(null)
  const generationRef = useRef(0)

  const load = useCallback(async () => {
    const generation = ++generationRef.current
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setNotice('')
    setWishes([])
    if (demo) {
      setWishes(fixtureWishes.filter((wish) => wish.dogId === dogId))
      setPhase('ready')
      return
    }

    setPhase('loading')
    try {
      const response = await fetch(
        `/api/dogs/${encodeURIComponent(dogId)}/wishes?includeRevoked=false`,
        { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' },
      )
      if (controller.signal.aborted || generation !== generationRef.current) return
      if (isForbidden(response.status)) {
        setPhase('unauthorized')
        setNotice('这只狗不在当前会话里。')
        return
      }
      if (!response.ok) {
        setPhase('failed')
        setNotice('这次没读出来，可以再试一次。')
        return
      }
      const data = (await response.json()) as { wishes: Wish[] }
      if (controller.signal.aborted || generation !== generationRef.current) return
      setWishes(data.wishes)
      setPhase('ready')
    } catch {
      if (controller.signal.aborted || generation !== generationRef.current) return
      setPhase('failed')
      setNotice('这次没读出来，可以再试一次。')
    }
  }, [demo, dogId])

  useEffect(() => {
    void load()
    return () => {
      generationRef.current += 1
      requestRef.current?.abort()
    }
  }, [load])

  async function addWish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = text.trim()
    const size = charCount(value)
    if (size < 1 || size > 200) {
      setNotice('心愿请写 1 到 200 字。')
      return
    }
    if (demo) {
      setNotice('这是示例数据，不会保存。')
      return
    }
    if (phase !== 'ready') {
      setNotice('读取还没成功，请先再试一次。')
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
      if (isForbidden(response.status)) {
        setPhase('unauthorized')
        setNotice('没有写入权限。')
        return
      }
      if (!response.ok) {
        setNotice('这次没记下，输入还在，可以再试一次。')
        return
      }
      const data = (await response.json()) as { wish: Wish }
      setWishes((previous) => [
        data.wish,
        ...previous.filter((wish) => wish.id !== data.wish.id),
      ])
      setText('')
      onCommitted()
    } catch {
      setNotice('这次没记下，输入还在，可以再试一次。')
    } finally {
      setBusy(false)
    }
  }

  async function revokeWish(wish: Wish) {
    if (pendingIds.has(wish.id)) return
    if (demo) {
      setNotice('这是示例数据，不会保存。')
      return
    }
    if (phase !== 'ready') {
      setNotice('读取还没成功，请先再试一次。')
      return
    }

    setPendingIds((previous) => new Set(previous).add(wish.id))
    setNotice('')
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
      if (isForbidden(response.status)) {
        setPhase('unauthorized')
        setNotice('没有撤销权限。')
        return
      }
      if (!response.ok) {
        setNotice('这条还没撤销成功，可以再试一次。')
        return
      }
      const data = (await response.json()) as { wish: Wish }
      // 只替换这一条，不拿旧数组整体覆盖别的改动；失败时也不动其它记录。
      setWishes((previous) => previous
        .map((item) => (item.id === data.wish.id ? data.wish : item))
        .filter((item) => item.revokedAt === null))
      onCommitted()
    } catch {
      setNotice('这条还没撤销成功，可以再试一次。')
    } finally {
      setPendingIds((previous) => {
        const next = new Set(previous)
        next.delete(wish.id)
        return next
      })
    }
  }

  const readOnly = demo || phase !== 'ready' || busy

  return (
    <section
      className={styles.panel}
      aria-label="心愿"
      data-reduced-motion={reducedMotion ? 'true' : undefined}
    >
      {demo && <p className={styles.notice}>这是示例数据，不会保存。</p>}

      {notice && (
        <p className={styles.notice} role="status">
          {notice}
          {!demo && phase === 'failed' && (
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
                disabled={pendingIds.has(wish.id) || readOnly}
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
          disabled={readOnly}
          onChange={(event) => setText(event.target.value)}
          placeholder="想看什么……"
        />
        <div className={styles.row}>
          <label htmlFor="b4-wish-category">类目</label>
          <select
            id="b4-wish-category"
            className={styles.select}
            value={category}
            disabled={readOnly}
            onChange={(event) => setCategory(event.target.value as InterestCategory)}
          >
            {INTEREST_CATEGORIES.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          <span className={styles.counter}>{charCount(text)}/200</span>
        </div>
        <button type="submit" className={styles.primaryButton} disabled={readOnly}>
          记下心愿
        </button>
      </form>
    </section>
  )
}
