import type { DatabaseSync } from 'node:sqlite'
import { sampleTripLifecycle } from './service.ts'

/**
 * The server's travel executor supplies a stable intent ID, reused for every retry.
 * Each operation is a separate C4 transaction, so a failed start leaves a resumable pending trip.
 */
export function createSeedTripRunner(db: DatabaseSync, options: { now?: () => Date } = {}) {
  return (dogId: string, intentId: string) => sampleTripLifecycle(db, dogId, intentId, options)
}
