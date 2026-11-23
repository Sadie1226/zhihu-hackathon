'use client'

import {
  Component,
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'
import type { DogView, SessionView } from '@/lib/adoption/view'
import type { CommitChange, Feature, PanelContext, ShellBindings } from './ports'
import { ProfilePanel, SettingsPanel } from './system-panels'
import { FeedbackSurface } from './feedback-surface'
import { ShellContext, useAppShell } from './context'
export { useAppShell } from './context'
import s from './shell.module.css'
import '@/components/v25/theme.css'
import '@/components/v25/integration.css'

const fixedIds = new Set([
  'profile',
  'settings',
  'chat',
  'wish',
  'mail',
  'journal',
])
export async function api<T>(
  url: string,
  body?: unknown,
  method = 'POST',
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : method,
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  })
  const result = await response.json()
  if (!response.ok)
    throw new Error(
      typeof result.publicMessage === 'string'
        ? result.publicMessage
        : typeof result.detail === 'string' ? result.detail
        : '这次没读出来，可以再试一次',
    )
  return result as T
}

class PanelBoundary extends Component<
  { children: ReactNode; active: boolean },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidUpdate(previous: { active: boolean }) {
    if (this.state.failed && this.props.active && !previous.active)
      this.setState({ failed: false })
  }
  render() {
    return this.state.failed ? (
      <p role="alert">这块暂时没打开，可以关闭后再试一次。</p>
    ) : (
      this.props.children
    )
  }
}

export function AppShellProvider({
  children,
  bindings = {},
}: {
  children: ReactNode
  bindings?: ShellBindings
}) {
  const [session, setSession] = useState<SessionView | null>(null)
  const [error, setError] = useState('')
  const [preference, setPreference] = useState(false)
  const [systemReduced, setSystemReduced] = useState(false)
  const [features, setFeatures] = useState<Feature[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [visited, setVisited] = useState<string[]>([])
  const [revisions, setRevisions] = useState<Partial<Record<CommitChange['resource'], number>>>({})
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const request = useRef<AbortController | null>(null)
  const registry = useRef(new Map<string, Feature>())
  const refresh = useCallback(async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    try {
      const value = await api<SessionView>(
        '/api/session',
        undefined,
        'GET',
        controller.signal,
      )
      if (!controller.signal.aborted) {
        setSession(value)
        setError('')
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setSession(null)
        setError(error instanceof Error ? error.message : '身份暂时没读出来')
      }
    }
  }, [])
  useEffect(() => {
    void refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      request.current?.abort()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setSystemReduced(media.matches)
    update()
    media.addEventListener('change', update)
    try {
      setPreference(localStorage.getItem('kanshan-reduced-motion') === 'true')
    } catch {
      /* Preference storage is optional. */
    }
    return () => media.removeEventListener('change', update)
  }, [])
  const setReducedMotion = useCallback((value: boolean) => {
    setPreference(value)
    try {
      localStorage.setItem('kanshan-reduced-motion', String(value))
    } catch {
      /* In-memory preference still applies. */
    }
  }, [])
  const registerFeature = useCallback((feature: Feature) => {
    if (
      fixedIds.has(feature.id) ||
      !/^[a-z][a-z0-9-]*$/.test(feature.id) ||
      !feature.label.trim() ||
      Array.from(feature.label).length > 4 ||
      registry.current.has(feature.id)
    ) {
      throw new Error(
        'Feature id must be new; label must contain 1–4 characters',
      )
    }
    registry.current.set(feature.id, feature)
    setFeatures([...registry.current.values()])
    return () => {
      if (registry.current.get(feature.id) === feature) {
        registry.current.delete(feature.id)
        setFeatures([...registry.current.values()])
        setActive((current) => (current === feature.id ? null : current))
      }
    }
  }, [])
  const closePanel = useCallback(() => setActive(null), [])
  const openPanel = useCallback((id: string) => {
    trigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    setVisited((previous) =>
      previous.includes(id) ? previous : [...previous, id],
    )
    setActive(id)
  }, [])
  useEffect(() => {
    const target = dialog.current
    if (!target) return
    if (active && !target.open) target.showModal()
    if (!active && target.open) {
      target.close()
      trigger.current?.focus()
    }
  }, [active])
  const dogId = session?.dog?.id
  const scope = `${session?.draftScope ?? ''}:${dogId ?? ''}`
  const currentScope = useRef(scope)
  currentScope.current = scope
  useEffect(() => {
    setActive(null)
    setVisited([])
    setRevisions({})
  }, [scope])
  const updateDog = useCallback(
    (dog: DogView) =>
      setSession((current) =>
        current?.dog?.id === dog.id ? { ...current, dog } : current,
      ),
    [],
  )
  const committed = useCallback((change?: CommitChange) => {
    if (currentScope.current !== scope) return
    if (change?.resource === 'dog') void refresh()
    else if (change) setRevisions(previous => ({ ...previous, [change.resource]: (previous[change.resource] ?? 0) + 1 }))
  }, [scope, refresh])
  const context: PanelContext = {
    dogId: dogId ?? '',
    reducedMotion: preference || systemReduced,
    onClose: closePanel,
    onCommitted: committed,
  }
  const titles: Record<string, string> = {
    profile: '它的小档案',
    settings: '小屋设置',
    chat: '和它坐一会儿',
    wish: '最近想看看什么？',
  }
  function panel(id: string) {
    if (id === 'profile') return <ProfilePanel />
    if (id === 'settings') return <SettingsPanel active={active === id} />
    const feature = features.find((item) => item.id === id)
    if (feature) return feature.render({ ...context, active: active === id })
    const Body =
      id === 'chat'
        ? bindings.ChatPanel
        : id === 'wish'
          ? bindings.WishPanel
          : null
    return Body && dogId ? (
      <Body {...context} active={active === id} />
    ) : (
      <p>这里暂时还没准备好。先在小屋坐一会儿吧。</p>
    )
  }
  return (
    <ShellContext.Provider
      value={{
        session,
        error,
        refresh,
        updateDog,
        reducedMotion: preference || systemReduced,
        setReducedMotion,
        openPanel,
        closePanel,
        registerFeature,
        features,
        bindings,
        revisions,
        committed,
      }}
    >
      {children}
      <FeedbackSurface><div data-v25="" className="v25-modal-scope">
        <dialog
          ref={dialog}
          className="home-panel v25-dialog"
          aria-labelledby="shell-panel-title"
          onCancel={closePanel}
          onClick={(event) => {
            if (event.target !== event.currentTarget) return
            const box = event.currentTarget.getBoundingClientRect()
            if (
              event.clientX < box.left || event.clientX > box.right ||
              event.clientY < box.top || event.clientY > box.bottom
            ) closePanel()
          }}
        >
          <div key={scope}>
            <div className="panel-heading">
              <h2 id="shell-panel-title">
                {titles[active ?? ''] ??
                  features.find((f) => f.id === active)?.label ??
                  '小屋'}
              </h2>
              <button type="button" onClick={closePanel} aria-label="关闭面板">
                关闭
              </button>
            </div>
            <p className="panel-demo">测试身份 · 模拟资料 · 参考外观</p>
            {visited.map((id) => (
              <div key={id} hidden={active !== id}>
                <PanelBoundary active={active === id}>
                  {panel(id)}
                </PanelBoundary>
              </div>
            ))}
          </div>
        </dialog>
      </div></FeedbackSurface>
    </ShellContext.Provider>
  )
}

export function SessionGate({ children }: { children: ReactNode }) {
  const { session, error, refresh } = useAppShell()
  const router = useRouter()
  useEffect(() => {
    if (session && (!session.authenticated || !session.dog))
      router.replace('/adopt')
  }, [session, router])
  if (error)
    return (
      <main className={s.page}>
        <p role="alert">{error}</p>
        <button
          onClick={() => {
            void refresh()
          }}
        >
          重新读取
        </button>
      </main>
    )
  if (!session?.dog)
    return (
      <main className={s.page}>
        <p role="status">正在打开小屋…</p>
      </main>
    )
  return <Fragment key={`${session.draftScope ?? ''}:${session.dog.id}`}>{children}</Fragment>
}
