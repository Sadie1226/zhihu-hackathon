import type { DatabaseSync } from 'node:sqlite'
import { nextVersion, validateSnapshot } from '../social/snapshot.ts'
import type { Snapshot } from '../social/snapshot.ts'

type Departure = { id: string; dogId: string }
type SnapshotMeta = Pick<Snapshot, 'dogId' | 'version' | 'createdAt'>

/** Adapter for the reviewed D deriveSnapshot + toSnapshot pair. */
export type BuildDepartureSnapshot = (db: DatabaseSync, meta: SnapshotMeta) => Snapshot

/** Only the C4 start transaction calls this, after eligibility and before any start writes. */
export function bindDepartureSnapshot(
  db: DatabaseSync, trip: Departure, at: string, build: BuildDepartureSnapshot,
): number {
  if (!db.isTransaction) throw new Error('Departure snapshot requires the C4 write transaction')
  if (!db.prepare("SELECT 1 FROM trip WHERE id = ? AND dog_id = ? AND status = 'pending'")
    .get(trip.id, trip.dogId)) throw new Error('Departure snapshot requires a matching pending trip')
  if (db.prepare('SELECT 1 FROM trip_snapshot WHERE trip_id = ?').get(trip.id)) {
    throw new Error('Pending trip already has a snapshot binding')
  }

  const previous = db.prepare('SELECT MAX(version) AS version FROM snapshot WHERE dog_id = ?').get(trip.dogId)?.version
  const version = nextVersion(previous === null ? null : Number(previous))
  if (!Number.isSafeInteger(version)) throw new Error('Invalid departure snapshot version')
  const result = validateSnapshot(build(db, { dogId: trip.dogId, version, createdAt: at }))
  if (!result.ok) throw new Error(`Invalid departure snapshot: ${result.code} at ${result.path}`)
  const snapshot = result.value
  if (snapshot.dogId !== trip.dogId || snapshot.version !== version || snapshot.createdAt !== at) {
    throw new Error('Departure snapshot metadata mismatch')
  }

  db.prepare(`INSERT INTO snapshot(dog_id, version, personality_tags, interest_categories, recent_trips, waiting_for, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    snapshot.dogId, snapshot.version, JSON.stringify(snapshot.personalityTags),
    snapshot.interestCategories === null ? null : JSON.stringify(snapshot.interestCategories),
    JSON.stringify(snapshot.recentTrips), snapshot.waitingFor, snapshot.createdAt,
  )
  db.prepare('INSERT INTO trip_snapshot(trip_id, dog_id, snapshot_version) VALUES (?, ?, ?)')
    .run(trip.id, trip.dogId, version)
  return version
}

/** Internal read. Existing unbound trips remain explicitly unbound. */
export function readDepartureSnapshot(db: DatabaseSync, tripId: string, dogId: string): Snapshot | null {
  const row = db.prepare(`
    SELECT s.dog_id, s.version, s.personality_tags, s.interest_categories, s.recent_trips, s.waiting_for, s.created_at
    FROM trip_snapshot b JOIN snapshot s ON s.dog_id = b.dog_id AND s.version = b.snapshot_version
    WHERE b.trip_id = ? AND b.dog_id = ?
  `).get(tripId, dogId)
  if (!row) return null
  const result = validateSnapshot({
    dogId: row.dog_id, version: row.version, createdAt: row.created_at,
    personalityTags: JSON.parse(String(row.personality_tags)),
    interestCategories: row.interest_categories === null ? null : JSON.parse(String(row.interest_categories)),
    recentTrips: JSON.parse(String(row.recent_trips)), waitingFor: row.waiting_for,
  })
  if (!result.ok) throw new Error(`Invalid bound snapshot: ${result.code} at ${result.path}`)
  return result.value
}
