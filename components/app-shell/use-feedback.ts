'use client'
import { useCallback, useEffect, useRef } from 'react'
import { useAppShell } from './context'
import type { Feedback } from './ports'

/** One scoped adapter, with cancellation on replacement, owner change and unmount. */
export function useFeedback() {
  const { session, bindings, reducedMotion } = useAppShell()
  const dogId = session?.dog?.id
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [dogId, bindings.feedback, reducedMotion])
  return useCallback((event: Feedback) => {
    pending.current?.abort()
    if (!bindings.feedback) return
    const controller = new AbortController()
    pending.current = controller
    try { bindings.feedback({ ...event, dogId }, { signal: controller.signal, reducedMotion }) }
    catch { controller.abort() } // Optional effects cannot interrupt the actual form action.
  }, [bindings.feedback, dogId, reducedMotion])
}
