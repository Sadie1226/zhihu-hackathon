import type { DatabaseSync } from 'node:sqlite'
import type { ContractError, Trip } from '../../contracts/types.ts'
import { resolveAuthContext } from '../auth/session.ts'
import { createTripEventSelector } from '../events/select.ts'
import type { EventConditions } from '../events/select.ts'
import { createTripDiscoveryComposer } from './composer.ts'
import type { DiscoveryComposition, TripObservation } from './composer.ts'
import { readDepartureSnapshot } from './departure-snapshot.ts'
import { createTripDiscoverySearch } from './discover.ts'
import type { DiscoverySearchOptions } from './discover.ts'
import { ownerDiscoveryIntent } from './discovery-receipt.ts'
import { TripError } from './errors.ts'
import { createFindStore, LegacyDiscoveryHoldError } from './finds.ts'
import { readOccurrenceFact } from './occurrence-facts.ts'
import type { SearchProvider } from './search-proof.ts'
import { seedIntentTripId } from './seed-event-scope.ts'
import { createSeedTripRunner } from './seed-runner.ts'
import { createTripService, isTerminal } from './service.ts'

type Action = { action: 'create' } | { action: 'resume'; tripId: string; retryDiscovery?: boolean }
type OwnerInput = Action & { request: Request; dogId: string }
type SeedInput = Action & { dogId: string; intentId: string }
type MaterialContext = Readonly<{
  trip: Readonly<Trip>
  occurrence: ReturnType<typeof readOccurrenceFact>
}>
type Material<T> = T | Promise<T>
type Options = DiscoverySearchOptions & {
  offline?: boolean
  provider?: SearchProvider
  random?: () => number
  conditions?: (trip: Readonly<Trip>) => Material<EventConditions | null>
  ownerObservations?: (context: MaterialContext) => Material<readonly TripObservation[]>
  seedObservations?: (context: MaterialContext) => Material<readonly (TripObservation & { kind: 'scene' })[]>
}
type Position = { trip: Trip; intentId: string }
type Degradation = { code: 'AUTH' | 'RATE_LIMITED'; alert: boolean }
export type TripExecutionResult = Position & (
  | (Extract<DiscoveryComposition, { status: 'complete' }> & { resumeAt: 'return'; degradation?: Degradation })
  | (Extract<DiscoveryComposition, { status: 'partial' }> & { resumeAt: 'discovery'; degradation?: Degradation })
  | { status: 'unconfirmed'; resumeAt: 'discovery' }
  | { status: 'search-error'; resumeAt: 'discovery'; error: ContractError; alert: boolean }
  | { status: 'pending'; resumeAt: 'start'; error: TripError }
  | { status: 'held' | 'unbound' | 'terminal'; resumeAt: null }
)

const missing = () => new TripError('NOT_FOUND', '这条记录不在这里')

/** Internal entry. The executor takes verified material providers, never client observations or sample credentials. */
export function createTripExecutor(db: DatabaseSync, options: Options = {}) {
  const finds = createFindStore(db, options)
  const compose = createTripDiscoveryComposer(db, options)
  const search = createTripDiscoverySearch(db, options.provider, options)

  async function advance(input: Action, initial: Trip, intentId: string, stages: {
    get: () => Trip
    start: () => { trip: Trip }
    confirmation: () => ReturnType<typeof finds.readConfirmation>
    selectEvent: (conditions: EventConditions | null) => unknown
    discover: (context: MaterialContext) => Promise<
      DiscoveryComposition & { degradation?: Degradation } |
      { status: 'search-error'; error: ContractError; alert: boolean }>
  }): Promise<TripExecutionResult> {
    let trip = initial
    const firstDeparture = trip.status === 'pending'
    const position = () => ({ trip, intentId })
    function inspect(): TripExecutionResult | null {
      trip = stages.get()
      if (isTerminal(trip.status)) return { ...position(), status: 'terminal', resumeAt: null }
      const confirmed = stages.confirmation()
      return confirmed ? { ...position(), ...confirmed, status: 'complete', reasons: [], resumeAt: 'return' } : null
    }
    try {
      if (isTerminal(trip.status)) return { ...position(), status: 'terminal', resumeAt: null }
      if (firstDeparture) {
        try { trip = stages.start().trip }
        catch (error) {
          if (!(error instanceof TripError) || error.code !== 'CONFLICT') throw error
          trip = stages.get()
          if (trip.status === 'pending') return { ...position(), status: 'pending', resumeAt: 'start', error }
          if (!isTerminal(trip.status)) throw error
        }
      }
      const prior = inspect()
      if (prior) return prior
      if (!readDepartureSnapshot(db, trip.id, trip.dogId)) {
        return { ...position(), status: 'unbound', resumeAt: null }
      }
      if (!firstDeparture && !(input.action === 'resume' && input.retryDiscovery)) {
        return { ...position(), status: 'unconfirmed', resumeAt: 'discovery' }
      }
      let occurrence = readOccurrenceFact(db, trip.id, trip.dogId)
      if (!occurrence) {
        const conditions = await options.conditions?.(Object.freeze({ ...trip })) ?? null
        const afterConditions = inspect()
        if (afterConditions) return afterConditions
        stages.selectEvent(conditions)
        occurrence = readOccurrenceFact(db, trip.id, trip.dogId)
      }
      const afterEvent = inspect()
      if (afterEvent) return afterEvent
      const result = await stages.discover({ trip: Object.freeze({ ...trip }), occurrence })
      if (result.status === 'complete') return { ...position(), ...result, resumeAt: 'return' }
      // A worker may have confirmed the batch while this worker was awaiting a failed search.
      if (result.status === 'search-error') {
        const winner = inspect()
        if (winner) return winner
      }
      return { ...position(), ...result, resumeAt: 'discovery' }
    } catch (error) {
      if (error instanceof LegacyDiscoveryHoldError) return { ...position(), status: 'held', resumeAt: null }
      if (error instanceof TripError && error.code === 'CONFLICT') {
        trip = stages.get()
        if (isTerminal(trip.status)) return { ...position(), status: 'terminal', resumeAt: null }
      }
      throw error
    }
  }

  async function owner(input: OwnerInput): Promise<TripExecutionResult> {
    const { request, dogId } = input
    const auth = resolveAuthContext(request, db)
    if (!auth) throw missing()
    const ownerId = auth.ownerId
    const authorizeOwner = (targetDog: string, targetOwner: string) => {
      const current = resolveAuthContext(request, db)
      if (current?.ownerId !== ownerId || targetOwner !== ownerId || targetDog !== dogId ||
          !db.prepare('SELECT 1 FROM dog WHERE id=? AND owner_id=? AND is_sample=0').get(targetDog, ownerId)) throw missing()
    }
    const lifecycle = createTripService(db, { now: options.now, authorizeOwner })
    const trip = input.action === 'create' ? lifecycle.create(dogId, ownerId, 'auto') : lifecycle.get(input.tripId, ownerId)
    const intentId = ownerDiscoveryIntent(trip.id)
    const confirmation = () => finds.readConfirmation({ tripId: trip.id, owner: request, intentId })
    const selector = createTripEventSelector(db, {
      now: options.now, random: options.random, authorizeOwner, shouldSelect: () => !confirmation(),
    })
    return advance(input, trip, intentId, {
      get: () => lifecycle.get(trip.id, ownerId),
      start: () => lifecycle.start(trip.id, ownerId),
      confirmation,
      selectEvent: conditions => selector({ dogId, tripId: trip.id, sessionId: ownerId, conditions }),
      async discover(context) {
        const observations = await options.ownerObservations?.(context)
        if (options.offline) return compose(trip.id, request, { intentId, observations })
        const result = await search(trip.id, request, intentId)
        if (!result.ok) return { status: 'search-error', error: result.error, alert: result.alert }
        if ('replay' in result) return { ...result.replay, status: 'complete', reasons: [] }
        const composition = compose(trip.id, request, { intentId, searchProofs: result.proofs, observations })
        return { ...composition, degradation: result.degradation }
      },
    })
  }

  async function seed(input: SeedInput): Promise<TripExecutionResult> {
    const { dogId, intentId } = input
    const tripId = seedIntentTripId(dogId, intentId)
    if (input.action === 'resume' && input.tripId !== tripId) throw missing()
    const lifecycle = createSeedTripRunner(db, options)(dogId, intentId)
    const trip = input.action === 'create' ? lifecycle.create() : lifecycle.get()
    const scope = { dogId, tripId, intentId }
    const confirmation = () => finds.readConfirmation(scope)
    const selector = createTripEventSelector(db, {
      now: options.now, random: options.random, shouldSelect: () => !confirmation(),
    })
    return advance(input, trip, intentId, {
      get: lifecycle.get,
      start: lifecycle.start,
      confirmation,
      selectEvent: conditions => selector.forSeed({ ...scope, conditions }),
      async discover(context) {
        const observations = await options.seedObservations?.(context)
        return compose.forSeed(scope, { observations })
      },
    })
  }

  return { owner, seed }
}
