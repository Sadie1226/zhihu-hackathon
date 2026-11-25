// 目标位置：app/(b)/b7-preferences-body.tsx
// B7 偏好正文，按 A 的 ShellBindings.PreferencesBody / PanelContext 导出（components/app-shell/ports.ts:72）。
// A 的 SettingsPanel 已留内部挂点（system-panels.tsx:97）：Preferences && session?.dog 时渲染。
// B 只交正文与自身业务：屏蔽主题写 dog.blocked_topics 列；A 负责绑定，B 不造宿主/设置页/导航。
'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { PanelContext } from './b4-ports'
import { MAX_BLOCKED_TOPICS, MAX_TOPIC_LENGTH } from '@/lib/preferences/blocked-topics'
import {
  canWriteTopics, phaseAfterDeactivate, type PreferencesPhase,
} from '@/lib/preferences/blocked-topics-ui'
import styles from './b4-panel.module.css'

function readableError(status: number): string {
  if (status === 404) return '这只伙伴不在这里了，回到小屋再看。'
  if (status === 409) return '这个词没能记下，先改一下再试。'
  if (status >= 500) return '这次没连上，输入还在，可以再试一次。'
  return '这次没存好，输入还在，可以再试一次。'
}

export function PreferencesBody({
  dogId, reducedMotion, active = true, onCommitted,
}: PanelContext) {
  const [phase, setPhase] = useState<PreferencesPhase>('loading')
  const [topics, setTopics] = useState<string[]>([])
  const [text, setText] = useState('')
  const [notice, setNotice] = useState('')
  const controllerRef = useRef<AbortController | null>(null)
  const aliveRef = useRef(true)
  // 主动重读计数：取消打断在途后、或读取失败点重试时递增，重新拉取服务端真值。
  const [reloadKey, setReloadKey] = useState(0)

  // 狗切换或卸载即作废在途请求：旧响应不能回填到新狗的设置里。
  useEffect(() => {
    aliveRef.current = true
    controllerRef.current?.abort()
    controllerRef.current = null
    setPhase('loading')
    setTopics([])
    setText('')
    setNotice('')
    const controller = new AbortController()
    controllerRef.current = controller
    void (async () => {
      try {
        const response = await fetch(`/api/dogs/${encodeURIComponent(dogId)}/blocked-topics`, {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        })
        if (!aliveRef.current || controller.signal.aborted) return
        if (!response.ok) {
          setPhase('error')
          setNotice(readableError(response.status))
          return
        }
        const data = (await response.json()) as { blockedTopics: string[] }
        if (!aliveRef.current || controller.signal.aborted) return
        setTopics(Array.isArray(data.blockedTopics) ? data.blockedTopics : [])
        setPhase('ready')
      } catch {
        if (!aliveRef.current || controller.signal.aborted) return
        setPhase('error')
        setNotice('这次没连上，可以再试一次。')
      }
    })()
    return () => {
      aliveRef.current = false
      controller.abort()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [dogId, reloadKey])

  // 面板取消：打断在途请求并把卡住的 loading/saving 复位；重开不自动重传，改为重读服务端真值。
  // 这样既避免「取消时正在保存 → phase 停在 saving → 重开后按钮永久禁用」，也不会用旧内存覆盖已写入的旧词。
  useEffect(() => {
    if (active) return
    controllerRef.current?.abort()
    controllerRef.current = null
    setPhase(current => phaseAfterDeactivate(current))
  }, [active])

  // 面板重新打开：若上次取消打断了在途读/写，重读一次拿到服务端真值，不重发未完成的写入。
  const wasActiveRef = useRef(active)
  useEffect(() => {
    const reopened = active && !wasActiveRef.current
    wasActiveRef.current = active
    if (reopened) setReloadKey(value => value + 1)
  }, [active])

  const save = useCallback(async (next: string[], successNotice: string) => {
    if (!canWriteTopics(phase, active)) return
    setPhase('saving')
    setNotice('')
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const response = await fetch(`/api/dogs/${encodeURIComponent(dogId)}/blocked-topics`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ blockedTopics: next }),
        signal: controller.signal,
      })
      if (!aliveRef.current || controller.signal.aborted) return
      if (!response.ok) {
        setPhase('ready')
        setNotice(readableError(response.status))
        return
      }
      const data = (await response.json()) as { blockedTopics: string[] }
      if (!aliveRef.current || controller.signal.aborted) return
      setTopics(Array.isArray(data.blockedTopics) ? data.blockedTopics : next)
      setText('')
      setPhase('ready')
      setNotice(successNotice)
      // 写的是 dog 自身的列，通知 A 刷新会话视图（system-panels 的 committed 对 resource:'dog' 走 refresh）。
      onCommitted({ resource: 'dog' })
    } catch {
      if (!aliveRef.current || controller.signal.aborted) return
      setPhase('ready')
      setNotice('这次没连上，输入还在，可以再试一次。')
    }
  }, [active, dogId, onCommitted, phase])

  const writable = canWriteTopics(phase, active)

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!writable) return
    const topic = text.normalize('NFKC').trim()
    if (!topic || topic.length > MAX_TOPIC_LENGTH) return
    if (topics.length >= MAX_BLOCKED_TOPICS) {
      setNotice(`最多记 ${MAX_BLOCKED_TOPICS} 个词，先删一个再试。`)
      return
    }
    void save([...topics, topic], '记下了。')
  }

  function remove(topic: string) {
    if (!writable) return
    void save(topics.filter((item) => item !== topic), '不再屏蔽这个词了。')
  }

  function retry() {
    setReloadKey(value => value + 1)
  }

  return (
    <section className={styles.panel} aria-label="表达偏好与边界" data-reduced-motion={reducedMotion ? 'true' : undefined}>
      <h3>不想看到的主题</h3>
      <p className={styles.hint}>说过的词不会再出现；它不会解释为什么，也不会因此催你。</p>

      {phase === 'error' ? (
        <>
          <p className={styles.notice} role="alert">{notice || '这次没读到已记下的主题。'}</p>
          <p className={styles.hint}>为免覆盖你已经记下的词，读取成功前不能改写；可以重试一次。</p>
          <button type="button" className={styles.primaryButton} onClick={retry}>再读一次</button>
        </>
      ) : (
        <>
          {phase === 'loading' ? (
            <p className={styles.notice}>正在取出已记下的主题。</p>
          ) : topics.length === 0 ? (
            <p className={styles.empty}>还没屏蔽任何主题。</p>
          ) : (
            <ul className={styles.thread} aria-live="polite">
              {topics.map((topic) => (
                <li key={topic}>
                  <span>{topic}</span>
                  <button type="button" disabled={!writable} onClick={() => remove(topic)}>
                    不再屏蔽
                  </button>
                </li>
              ))}
            </ul>
          )}

          {notice && <p className={styles.notice} role="status">{notice}</p>}

          <form onSubmit={add}>
            <label htmlFor="b7-blocked-topic">加一个不想出现的词</label>
            <input
              id="b7-blocked-topic"
              value={text}
              maxLength={MAX_TOPIC_LENGTH}
              onChange={(event) => setText(event.target.value)}
              disabled={!writable}
            />
            <button type="submit" className={styles.primaryButton} disabled={!writable || !text.trim()}>
              记下来
            </button>
          </form>
        </>
      )}
    </section>
  )
}
