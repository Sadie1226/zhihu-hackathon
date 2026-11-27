import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { clearTimeout, setTimeout } from 'node:timers'
import type { Find, Message, Trip } from '../../contracts/types.ts'
import { resolveAuthContext } from '../auth/session.ts'
import { ownerDiscoveryIntent } from './discovery-receipt.ts'
import { TripError } from './errors.ts'
import { readBlockedTopics } from './find-scope.ts'
import { createFindStore, LegacyDiscoveryHoldError } from './finds.ts'
import { blockedBy } from './search-proof.ts'
import { seedIntentTripId } from './seed-event-scope.ts'
import { createTripService, isTerminal, sampleTripLifecycle } from './service.ts'
import type { TerminalStatus } from './service.ts'

type Input = { tripId: string; dogId: string }
type Scope = { kind: 'owner'; ownerId: string } | { kind: 'seed' }
type GenerationInput = Readonly<{
  scope: Scope['kind']
  finds: readonly Readonly<Find>[]
}>
type MessageTarget = Readonly<{
  id: string
  tripId: string
  createdAt: string
  allowedFindIds: readonly string[]
}>
type Options = {
  now?: () => Date
  generationTimeoutMs: number
  generate: (input: GenerationInput, signal: AbortSignal) => Promise<unknown>
  /** B5: validate the draft and insert exactly one supplied ID on this connection, synchronously. */
  writeMessageInTransaction: (db: DatabaseSync, target: MessageTarget, draft: unknown) => undefined
}
type Result =
  | { status: 'confirmed'; trip: Trip; message: Message; replayed: boolean }
  | { status: 'confirmed-hidden'; trip: Trip }
  | { status: 'not-ready'; trip: Trip; reason: 'pending' | 'no-receipt' | 'no-visible-finds' }
  | { status: 'held' | 'terminal'; trip: Trip }
  | { status: 'generation-failed'; trip: Trip; reason: 'failed' | 'timeout' }

const missing = () => new TripError('NOT_FOUND', '这条记录不在这里')
const changed = () => new TripError('CONFLICT', '归来分享的出行依据已变更')
const integrity = () => new Error('Automatic return Message does not match its Trip or discovery receipt')

function automaticId(scope: Scope, { dogId, tripId }: Input, intentId: string): string {
  const basis = ['c10-auto-return-v1', scope.kind, scope.kind === 'owner' ? scope.ownerId : null, dogId, tripId, intentId]
  return 'msg_auto_return_v1_' + createHash('sha256').update(JSON.stringify(basis)).digest('hex')
}

async function generateWithDeadline(
  generate: Options['generate'], input: GenerationInput, duration: number,
): Promise<{ draft: unknown } | { failure: 'failed' | 'timeout' }> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<{ failure: 'timeout' }>(resolve => {
    timer = setTimeout(() => {
      resolve({ failure: 'timeout' })
      controller.abort()
    }, duration)
  })
  try {
    const generated = Promise.resolve().then(() => generate(input, controller.signal))
      .then(draft => ({ draft }), () => ({ failure: 'failed' as const }))
    return await Promise.race([deadline, generated])
  } finally {
    clearTimeout(timer)
  }
}

/** C transaction coordinator. B supplies production generation and the transaction-local writer. */
export function createTripReturn(db: DatabaseSync, options: Options) {
  if (!Number.isSafeInteger(options.generationTimeoutMs) || options.generationTimeoutMs < 1 ||
      options.generationTimeoutMs > 2_147_483_647) throw new Error('Invalid return generation timeout')
  const finds = createFindStore(db, { now: options.now })
  const messageById = db.prepare(`SELECT id, trip_id AS tripId, text,
    mentions_find_id AS mentionsFindId, created_at AS createdAt FROM message WHERE id = ?`)
  const topicsByDog = db.prepare('SELECT blocked_topics FROM dog WHERE id = ?')
  const topicsFor = (trip: Trip) => readBlockedTopics(topicsByDog.get(trip.dogId)?.blocked_topics)
  const run = async (input: Input, scope: Scope, intentId: string,
    transact: <T>(action: (trip: Trip, transition: (status: TerminalStatus) => Trip) => T) => T,
    confirmation: (allowDone?: boolean) => ReturnType<typeof finds.readConfirmation>,
  ): Promise<Result> => {
    const id = automaticId(scope, input, intentId)
    const saved = (): Message | undefined => {
      const row = messageById.get(id)
      if (!row) return undefined
      const { tripId, text, mentionsFindId, createdAt } = row
      if (typeof tripId !== 'string' || typeof text !== 'string' || !text.trim() ||
          typeof createdAt !== 'string' || (mentionsFindId !== null && typeof mentionsFindId !== 'string')) throw integrity()
      return { id, tripId, text, mentionsFindId, createdAt }
    }
    function inspect(trip: Trip): Result | { basis: string; input: GenerationInput } {
      if (trip.dogId !== input.dogId) throw missing()
      const message = saved()
      if (message) {
        if (trip.status !== 'done' || message.tripId !== trip.id || message.createdAt !== trip.endedAt) throw integrity()
        const current = confirmation(true)
        if (!current || Date.parse(current.confirmation.completedAt) > Date.parse(trip.endedAt!)) throw integrity()
        // With no persisted model-input subset, fail closed when membership was filtered.
        if (current.confirmation.visibilityReasons.length > 0) return { status: 'confirmed-hidden', trip }
        if (message.mentionsFindId !== null && !current.finds.some(find => find.id === message.mentionsFindId)) throw integrity()
        if (blockedBy(topicsFor(trip), message.text)) return { status: 'confirmed-hidden', trip }
        return { status: 'confirmed', trip, message, replayed: true }
      }
      if (isTerminal(trip.status)) return { status: 'terminal', trip }
      if (trip.status !== 'running') return { status: 'not-ready', trip, reason: 'pending' }
      let current
      try { current = confirmation() }
      catch (error) {
        if (error instanceof LegacyDiscoveryHoldError) return { status: 'held', trip }
        throw error
      }
      if (!current) return { status: 'not-ready', trip, reason: 'no-receipt' }
      if (current.finds.length === 0) return { status: 'not-ready', trip, reason: 'no-visible-finds' }
      const visible = Object.freeze(current.finds.map(find => Object.freeze({ ...find })))
      return {
        basis: JSON.stringify([trip.startedAt, current.confirmation.completedAt, visible, topicsFor(trip)]),
        input: Object.freeze({ scope: scope.kind, finds: visible }),
      }
    }

    const prepared = transact(trip => inspect(trip))
    if (!('basis' in prepared)) return prepared
    const generated = await generateWithDeadline(options.generate, prepared.input, options.generationTimeoutMs)
    return transact((trip, transition) => {
      const current = inspect(trip)
      if (!('basis' in current)) {
        if (current.status === 'not-ready') throw changed()
        return current
      }
      if (current.basis !== prepared.basis) throw changed()
      if ('failure' in generated) {
        return { status: 'generation-failed', trip: transition(generated.failure), reason: generated.failure }
      }
      const ended = transition('done')
      if (!ended.endedAt) throw integrity()
      const allowedFindIds = Object.freeze(current.input.finds.map(find => find.id))
      const target = Object.freeze({ id, tripId: trip.id, createdAt: ended.endedAt, allowedFindIds })
      if (options.writeMessageInTransaction(db, target, generated.draft) !== undefined) {
        throw new Error('B5 writer must run synchronously')
      }
      const message = saved()
      if (!message || message.tripId !== trip.id || message.createdAt !== ended.endedAt ||
          (message.mentionsFindId !== null && !allowedFindIds.includes(message.mentionsFindId))) throw integrity()
      if (blockedBy(topicsFor(trip), message.text)) throw changed()
      return { status: 'confirmed', trip: ended, message, replayed: false }
    })
  }

  return {
    async owner(input: Input & { request: Request }): Promise<Result> {
      const { request, tripId, dogId } = input
      const auth = resolveAuthContext(request, db)
      if (!auth) throw missing()
      const lifecycle = createTripService(db, { now: options.now, authorizeOwner(targetDog, ownerId) {
        if (targetDog !== dogId || ownerId !== auth.ownerId || resolveAuthContext(request, db)?.tokenHash !== auth.tokenHash ||
            !db.prepare('SELECT 1 FROM dog WHERE id=? AND owner_id=? AND is_sample=0').get(dogId, ownerId)) throw missing()
      } })
      const intentId = ownerDiscoveryIntent(tripId)
      return run({ tripId, dogId }, { kind: 'owner', ownerId: auth.ownerId }, intentId,
        action => lifecycle.withFinishTransaction(tripId, auth.ownerId, action),
        allowDone => finds.readConfirmation({ tripId, owner: request, intentId }, allowDone))
    },
    async seed(input: Input & { intentId: string }): Promise<Result> {
      const { dogId, tripId, intentId } = input
      if (seedIntentTripId(dogId, intentId) !== tripId) throw missing()
      const lifecycle = sampleTripLifecycle(db, dogId, intentId, { now: options.now })
      return run({ tripId, dogId }, { kind: 'seed' }, intentId, lifecycle.withFinishTransaction,
        allowDone => finds.readConfirmation({ tripId, dogId, intentId }, allowDone))
    },
  }
}
