import type { DatabaseSync } from 'node:sqlite'
import { composeReturnMessage, createB5ReturnPorts } from '../messages/return-adapter.ts'
import type { ReturnCompose } from '../messages/return-adapter.ts'
import { TripError } from './errors.ts'
import { createTripScheduler } from './scheduler.ts'

type SchedulerOptions = NonNullable<Parameters<typeof createTripScheduler>[1]>
type Options = Omit<SchedulerOptions, 'returnPorts'> & {
  generationTimeoutMs: number
  compose?: ReturnCompose
}

/** Internal server entry for the reviewed B5 adapter. Its default composer is local text. */
export function createB5TripScheduler(db: DatabaseSync, { compose = composeReturnMessage, generationTimeoutMs, ...options }: Options) {
  const { writeMessageInTransaction } = createB5ReturnPorts(db)
  return createTripScheduler(db, {
    ...options,
    returnPorts: {
      generationTimeoutMs,
      writeMessageInTransaction,
      generate(input, signal, profile) {
        const tags: unknown = JSON.parse(profile.personalityTags)
        // B reads the profile independently. Compare the actual composer inputs
        // with C's prior snapshot, then C rechecks that snapshot before COMMIT.
        const ports = createB5ReturnPorts(db, { compose(actual, activeSignal) {
          if (JSON.stringify(actual.personalityTags) !== JSON.stringify(tags) ||
              JSON.stringify(actual.blockedTopics) !== JSON.stringify(profile.blockedTopics)) {
            throw new TripError('CONFLICT', '归来分享的出行依据已变更')
          }
          return compose(actual, activeSignal)
        } })
        return ports.generate(input, signal)
      },
    },
  })
}
