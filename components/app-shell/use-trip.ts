'use client'
import { useEffect, useRef, useState } from 'react'
import type { Trip } from '@/contracts/types'
import { currentTrip } from '@/lib/adoption/view'
import { pollTrip } from '@/lib/trips/poll'
import { api } from './shell'

export function useCurrentTrip(dogId?: string) {
  const [trip, setTrip] = useState<Trip | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const owner = useRef<string | undefined>(undefined)
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === 'visible') setRevision((v) => v + 1)
    }
    document.addEventListener('visibilitychange', visible)
    return () => document.removeEventListener('visibilitychange', visible)
  }, [])
  useEffect(() => {
    if (!dogId) return
    const controller = new AbortController()
    let stop: (() => void) | undefined
    let nextList: ReturnType<typeof setTimeout> | undefined
    if (owner.current !== dogId) {
      setTrip(null)
      setLoading(true)
      owner.current = dogId
    }
    setError('')
    const checkLater = () => {
      nextList = setTimeout(() => setRevision((v) => v + 1), 30_000)
    }
    void api<{ trips: Trip[] }>(
      `/api/dogs/${encodeURIComponent(dogId)}/trips?limit=2`,
      undefined,
      'GET',
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return
        const latest = currentTrip(result.trips)
        setTrip(latest)
        setLoading(false)
        if (latest && ['pending', 'running'].includes(latest.status))
          stop = pollTrip(latest.id, {
            signal: controller.signal,
            onTrip: (value) => {
              setTrip(value)
              if (['done', 'timeout', 'failed'].includes(value.status))
                checkLater()
            },
            onError: () => setError('路上的消息暂时没读到，可以重新读取。'),
          })
        else checkLater()
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setError('出行记录暂时没读到。')
          setLoading(false)
        }
      })
    return () => {
      controller.abort()
      stop?.()
      if (nextList !== undefined) clearTimeout(nextList)
    }
  }, [dogId, revision])
  return {
    trip,
    loading,
    error,
    retry: () => setRevision((value) => value + 1),
  }
}
