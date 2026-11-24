import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { createTripService } from '../../lib/trips/service.ts'

const { path, tripId, sessionId, at } = workerData
const db = new DatabaseSync(path, { timeout: 5000 })
db.exec('PRAGMA foreign_keys = ON')
const service = createTripService(db, {
  now: () => new Date(at),
  buildDepartureSnapshot: (_db, meta) => ({
    ...meta, personalityTags: ['好奇', '看物', '直给'], interestCategories: null, recentTrips: [], waitingFor: null,
  }),
})
parentPort.postMessage('ready')
parentPort.once('message', () => {
  try {
    parentPort.postMessage(service.start(tripId, sessionId))
  } finally {
    db.close()
    parentPort.close()
  }
})
