import type { DatabaseSync } from 'node:sqlite'
import { resolveAuthContext } from '../auth/session.ts'
import { TripError } from './errors.ts'
import { createTripExecutor } from './executor.ts'
import type { TripExecutionResult } from './executor.ts'
import { createTripReturn } from './return.ts'
import { createTripService, sampleTripLifecycle } from './service.ts'

type ExecutorOptions = NonNullable<Parameters<typeof createTripExecutor>[1]>
type ReturnOptions = Omit<Parameters<typeof createTripReturn>[1], 'now'>
type Options = {
  executor?: Omit<ExecutorOptions, 'now' | 'offline'>
  returnPorts?: ReturnOptions
  /** Server configuration only. Live scheduling and C9 use the same real clock. */
  now?: () => Date
}
type Trigger = { dogId: string; intentId: string; retryDiscovery?: boolean }
type OwnerTrigger = Trigger & { request: Request }
type ReturnResult = Awaited<ReturnType<ReturnType<typeof createTripReturn>['owner']>>
type ScheduleResult = { discovery: TripExecutionResult; return: ReturnResult | null }

const missing = () => new TripError('NOT_FOUND', '这条记录不在这里')

function scheduler(db: DatabaseSync, options: Options, now: () => Date, offline: boolean) {
  const executor = createTripExecutor(db, { ...options.executor, now, offline })
  const tripReturn = options.returnPorts && createTripReturn(db, { ...options.returnPorts, now })

  // A done Trip has no discovery write path, but may have an exact auto-return to replay.
  const canReturn = (result: TripExecutionResult) => result.status === 'complete' || result.trip.status === 'done'
  return {
    async owner({ dogId, request, intentId, retryDiscovery }: OwnerTrigger): Promise<ScheduleResult> {
      const auth = resolveAuthContext(request, db)
      if (!auth) throw missing()
      const c4 = createTripService(db, { now, authorizeOwner(targetDog, ownerId) {
        if (targetDog !== dogId || ownerId !== auth.ownerId || resolveAuthContext(request, db)?.tokenHash !== auth.tokenHash ||
            !db.prepare('SELECT 1 FROM dog WHERE id=? AND owner_id=? AND is_sample=0').get(dogId, ownerId)) throw missing()
      } })
      const tripId = c4.schedule(dogId, auth.ownerId, intentId).id
      const result = await executor.owner({ action: 'resume', tripId, dogId, request, retryDiscovery })
      const returned = tripReturn && canReturn(result) ? await tripReturn.owner({ tripId, dogId, request }) : null
      return { discovery: result, return: returned }
    },
    async seed({ dogId, intentId, retryDiscovery }: Trigger): Promise<ScheduleResult> {
      const tripId = sampleTripLifecycle(db, dogId, intentId, { now }).schedule().id
      const result = await executor.seed({ action: 'resume', tripId, dogId, intentId, retryDiscovery })
      const returned = tripReturn && canReturn(result) ? await tripReturn.seed({ tripId, dogId, intentId }) : null
      return { discovery: result, return: returned }
    },
  }
}

/** Called by a trusted producer with its original durable event key. No implicit time slots. */
export function createTripScheduler(db: DatabaseSync, options: Options = {}) {
  return scheduler(db, options, options.now ?? (() => new Date()), false)
}

/**
 * Offline demonstration entry for an explicitly isolated database.
 * The caller preserves the event key and absolute target instant across retries.
 * No provider/cache or return generation is configured in this mode.
 */
export function createTravelDial(db: DatabaseSync,
  materials: Pick<ExecutorOptions, 'conditions' | 'ownerObservations' | 'seedObservations' | 'random'> = {},
) {
  const atTarget = (target: string) => {
    const instant = new Date(target)
    if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== target) {
      throw new TripError('CONFLICT', '演示时间需要 UTC ISO 时间')
    }
    return scheduler(db, { executor: materials }, () => new Date(instant), true)
  }
  return {
    owner: (input: OwnerTrigger & { target: string }) => atTarget(input.target).owner(input),
    seed: (input: Trigger & { target: string }) => atTarget(input.target).seed(input),
  }
}
