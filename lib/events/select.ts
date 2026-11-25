import type { DatabaseSync } from 'node:sqlite'
import type { EventWeather, Season, TimeOfDay } from '../../contracts/types.ts'
import { blockedBy } from '../trips/search-proof.ts'
import { requireRunningSeedEventTrip } from '../trips/seed-event-scope.ts'
import { createTripService, TripError } from '../trips/service.ts'
import { resolveSceneContext } from './scene-context.ts'
import { sceneAllowsEvent } from './semantic-policy.ts'

export type EventConditions = {
  sceneFile: string
  season: Exclude<Season, 'any'>
  weather: Exclude<EventWeather, 'any'>
  timeOfDay: Exclude<TimeOfDay, 'any'>
}

/** Only the trusted server executor builds this input. sessionId is the C4 ownership key. */
type EventSelectionTarget = {
  dogId: string
  tripId: string
  conditions: EventConditions | null
}

export type EventSelectionInput = EventSelectionTarget & {
  sessionId: string
}

type SeedEventSelectionInput = EventSelectionTarget & { intentId: string }
type EventProfile = { startedAt: string; interestCategories: string | null; blockedTopics: string }
export type SelectedTripEvent = { tripId: string; eventId: string; dogId: string; happenedAt: string }
type Candidate = { id: string; code: string; text: string; placeTags: string; matchTags: string; weight: number; cooldownDays: number }
const dayMs = 24 * 60 * 60 * 1000

function knownConditions(conditions: EventConditions) {
  return ['spring', 'summer', 'autumn', 'winter'].includes(conditions.season) &&
    ['clear', 'rain', 'snow'].includes(conditions.weather) &&
    ['morning', 'dusk', 'night'].includes(conditions.timeOfDay)
}

function stringList(json: string): string[] {
  const value: unknown = JSON.parse(json)
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) throw new Error('Invalid event data')
  return value
}

function timestamp(value: string | null): number {
  const parsed = value?.endsWith('Z') ? Date.parse(value) : NaN
  if (!Number.isFinite(parsed)) throw new Error('Invalid UTC trip event time')
  return parsed
}

function draw(candidates: Candidate[], random: () => number): Candidate | undefined {
  if (candidates.length === 0) return undefined
  const maximum = candidates.reduce((largest, row) => Math.max(largest, row.weight), 0)
  const total = candidates.reduce((sum, row) => sum + row.weight / maximum, 0)
  const fraction = random()
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) throw new Error('Invalid event random draw')
  const target = fraction * total
  let cumulative = 0
  for (const row of candidates) {
    cumulative += row.weight / maximum
    if (target < cumulative) return row
  }
  // Floating point rounding can put the last draw on the final boundary.
  return candidates.at(-1)
}

/** Run outside any other transaction. Exactly one recorded occurrence is reused on retry. */
export function createTripEventSelector(db: DatabaseSync, options: { now?: () => Date; random?: () => number } = {}) {
  const trips = createTripService(db)
  const now = options.now ?? (() => new Date())
  const random = options.random ?? Math.random
  const occurrence = db.prepare(`SELECT trip_id AS tripId, event_id AS eventId, dog_id AS dogId,
    happened_at AS happenedAt FROM trip_event WHERE trip_id = ? LIMIT 2`)
  const dogQuery = db.prepare(`SELECT interest_categories AS interestCategories, blocked_topics AS blockedTopics
    FROM dog WHERE id = ? AND session_id = ? AND is_sample = 0`)
  const candidateQuery = db.prepare(`SELECT id, code, text, place_tags AS placeTags, match_tags AS matchTags,
    weight, cooldown_days AS cooldownDays FROM event WHERE enabled = 1
    AND season IN ('any', ?) AND weather IN ('any', ?) AND time_of_day IN ('any', ?) ORDER BY code`)
  const history = db.prepare(`SELECT te.event_id AS eventId, te.happened_at AS happenedAt
    FROM trip_event te JOIN trip t ON t.id = te.trip_id AND t.dog_id = te.dog_id
    WHERE te.dog_id = ? AND te.trip_id <> ?`)
  const insert = db.prepare('INSERT INTO trip_event(trip_id,event_id,dog_id,happened_at) VALUES(?,?,?,?)')

  function choose({ dogId, tripId, conditions }: EventSelectionTarget, profile: EventProfile, at: number): Candidate | undefined {
    if (!conditions || !knownConditions(conditions)) return undefined
    const scene = resolveSceneContext(conditions.sceneFile)
    if (!scene) return undefined
    const interests = profile.interestCategories === null ? null : stringList(profile.interestCategories)
    const blocked = stringList(profile.blockedTopics)
    const candidates = (candidateQuery.all(conditions.season, conditions.weather, conditions.timeOfDay) as Candidate[])
      .filter(row => {
        const tags = stringList(row.placeTags)
        if (tags.length && !scene.availablePlaces.some(tag => tags.includes(tag))) return false
        if (!sceneAllowsEvent(scene.sceneFile, row)) return false
        const match = stringList(row.matchTags)
        return (interests === null || !match.length || match.some(tag => interests.includes(tag))) &&
          !blockedBy(blocked, row.text, ...match)
      })
    if (!candidates.length) return undefined
    const eligibleIds = new Set(candidates.map(row => row.id))
    const latest = new Map<string, number>()
    for (const row of history.all(dogId, tripId)) {
      const id = String(row.eventId)
      if (eligibleIds.has(id)) latest.set(id, Math.max(latest.get(id) ?? -Infinity, timestamp(String(row.happenedAt))))
    }
    return draw(candidates.filter(row => {
      if (!Number.isFinite(row.weight) || row.weight <= 0 || !Number.isFinite(row.cooldownDays) || row.cooldownDays < 0) {
        throw new Error('Invalid event weight or cooldown')
      }
      return at - (latest.get(row.id) ?? -Infinity) >= row.cooldownDays * dayMs
    }), random)
  }

  function pickEvent(input: EventSelectionTarget, authorize: () => EventProfile): SelectedTripEvent | null {
    const { dogId, tripId } = input
    if (db.isTransaction) throw new Error('Event selection requires a separate transaction after start commits')
    db.exec('BEGIN IMMEDIATE')
    try {
      const profile = authorize()
      const started = timestamp(profile.startedAt)
      let result: SelectedTripEvent | null = null
      const existing = occurrence.all(tripId) as SelectedTripEvent[]
      if (existing.length > 0) {
        const recorded = existing[0]
        const recordedAt = timestamp(recorded.happenedAt)
        if (existing.length !== 1 || recorded.dogId !== dogId || recordedAt < started) {
          throw new Error('Inconsistent trip event history')
        }
        result = { ...recorded }
      } else {
        const current = now()
        const happenedAt = current.toISOString()
        if (current.getTime() < started) throw new TripError('CONFLICT', '事件时间早于出发')
        const picked = choose(input, profile, current.getTime())
        if (picked) {
          insert.run(tripId, picked.id, dogId, happenedAt)
          result = { tripId, eventId: picked.id, dogId, happenedAt }
        }
      }
      db.exec('COMMIT')
      return result
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    }
  }

  const pickForOwner = (input: EventSelectionInput) => pickEvent(input, () => {
    const { dogId, tripId, sessionId } = input
    const trip = trips.get(tripId, sessionId)
    const dog = dogQuery.get(dogId, sessionId)
    if (trip.dogId !== dogId || !dog) throw new TripError('NOT_FOUND', '这条记录不在这里')
    if (trip.status !== 'running' || trip.startedAt === null) throw new TripError('CONFLICT', '这次出行尚未运行或已经结束')
    return {
      startedAt: trip.startedAt,
      interestCategories: dog.interestCategories === null ? null : String(dog.interestCategories),
      blockedTopics: String(dog.blockedTopics),
    }
  })

  return Object.assign(pickForOwner, {
    forSeed: (input: SeedEventSelectionInput) => pickEvent(input, () => requireRunningSeedEventTrip(db, input)),
  })
}
