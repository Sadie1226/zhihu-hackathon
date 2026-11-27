import type { OccurrenceFactReader } from '../social/snapshot-derive.ts'

/** C's v7 history view -> D's fixed-fact interface. SELECT only, no template fallback. */
export const readOccurrenceFact: OccurrenceFactReader = (db, tripId, dogId) => {
  const row = db.prepare(`
    SELECT event_id, happened_at, event_code_at_occurrence,
      public_text_at_occurrence, history_status
    FROM v_trip_event_history
    WHERE trip_id = ? AND dog_id = ?
    ORDER BY julianday(happened_at), event_id
    LIMIT 1
  `).get(tripId, dogId)
  if (!row || row.history_status === 'unverifiable') return null
  if (row.history_status !== 'frozen' || typeof row.public_text_at_occurrence !== 'string' ||
      typeof row.event_code_at_occurrence !== 'string' || typeof row.happened_at !== 'string' ||
      typeof row.event_id !== 'string') {
    throw new Error('Invalid v7 occurrence fact')
  }
  return {
    text: row.public_text_at_occurrence,
    sourceId: `trip_event_fact:${JSON.stringify([tripId, row.event_id])}`,
    capturedAt: row.happened_at,
  }
}
