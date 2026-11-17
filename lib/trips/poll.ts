import type { Trip } from '../../contracts/types.ts'

export const TRIP_POLL_INTERVAL_MS = 700
type Timer = ReturnType<typeof globalThis.setTimeout>
type PollOptions = {
  onTrip: (trip: Trip) => void
  onError: (error: Error) => void
  signal?: AbortSignal
  fetch?: typeof globalThis.fetch
  setTimeout?: (callback: () => void, milliseconds: number) => Timer
  clearTimeout?: (timer: Timer) => void
}

/** Immediate first read, then 700ms after each successful read. Return stop() from useEffect cleanup. */
export function pollTrip(id: string, options: PollOptions): () => void {
  const controller = new AbortController()
  const schedule = options.setTimeout ?? globalThis.setTimeout
  const clear = options.clearTimeout ?? globalThis.clearTimeout
  let timer: Timer | undefined
  let stopped = false
  function stop() {
    stopped = true
    controller.abort()
    if (timer !== undefined) clear(timer)
    options.signal?.removeEventListener('abort', stop)
  }
  async function tick() {
    try {
      const response = await (options.fetch ?? globalThis.fetch)(`/api/trips/${encodeURIComponent(id)}`, {
        signal: controller.signal, cache: 'no-store', credentials: 'same-origin',
      })
      if (!response.ok) throw new Error(`Trip request failed (${response.status})`)
      const { trip } = await response.json() as { trip?: Trip }
      if (!trip || trip.id !== id || !['pending', 'running', 'done', 'failed', 'timeout'].includes(trip.status)) {
        throw new Error('Invalid trip response')
      }
      if (stopped) return
      options.onTrip(trip)
      if (stopped) return
      if (['done', 'failed', 'timeout'].includes(trip.status)) stop()
      else timer = schedule(() => { void tick() }, TRIP_POLL_INTERVAL_MS)
    } catch (error) {
      if (stopped) return
      stop()
      options.onError(error instanceof Error ? error : new Error('Trip request failed'))
    }
  }
  if (options.signal?.aborted) stop()
  else {
    options.signal?.addEventListener('abort', stop, { once: true })
    void tick()
  }
  return stop
}
