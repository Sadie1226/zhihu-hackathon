import type { DatabaseSync } from 'node:sqlite'
import { createTripEventSelector } from '../events/select.ts'
import type { EventConditions } from '../events/select.ts'
import { seedIntentTripId } from './seed-event-scope.ts'
import { sampleTripLifecycle } from './service.ts'

/**
 * The server's travel executor supplies a stable intent ID, reused for every retry.
 * Each operation is a separate C4 transaction, so a failed start leaves a resumable pending trip.
 */
export function createSeedTripRunner(db: DatabaseSync, options: { now?: () => Date } = {}) {
  return (dogId: string, intentId: string) => {
    const lifecycle = sampleTripLifecycle(db, dogId, intentId, options)
    const tripId = seedIntentTripId(dogId, intentId)
    return {
      ...lifecycle,
      selectEvent: (conditions: EventConditions | null) =>
        createTripEventSelector(db, options).forSeed({ dogId, tripId, intentId, conditions }),
    }
  }
}
