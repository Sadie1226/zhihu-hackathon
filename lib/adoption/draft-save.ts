/** Coalesce slider draft writes; identity changes discard pending work. */
export function createDraftSave<T>(
  write: (scope: string, value: T) => void,
  clock = {
    schedule: (run: () => void) => setTimeout(run, 200),
    cancel: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  },
) {
  let scope: string | null = null
  let pending: { scope: string; value: T } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function clear() {
    if (timer !== null) clock.cancel(timer)
    timer = null
    pending = null
  }
  function flush() {
    const next = pending
    clear()
    if (!next || next.scope !== scope) return
    try {
      write(next.scope, next.value)
    } catch {
      // Draft storage is optional; in-memory input must remain usable.
    }
  }
  return {
    setScope(next: string | null) {
      if (next !== scope) clear()
      scope = next
    },
    save(value: T, deferred = false) {
      if (scope === null) return
      if (timer !== null) clock.cancel(timer)
      timer = null
      pending = { scope, value }
      if (deferred) timer = clock.schedule(flush)
      else flush()
    },
    flush,
    clear,
  }
}
