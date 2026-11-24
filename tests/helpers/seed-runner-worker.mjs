import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { createSeedTripRunner } from '../../lib/trips/seed-runner.ts'

const { path, dogId, at } = workerData
const db = new DatabaseSync(path, { timeout: 5000 })
db.exec('PRAGMA foreign_keys = ON')
const intent = createSeedTripRunner(db, { now: () => new Date(at) })(dogId, 'test-concurrency')
parentPort.postMessage('ready')
parentPort.once('message', () => {
  try {
    intent.create()
    parentPort.postMessage(intent.start())
  } finally {
    db.close()
    parentPort.close()
  }
})
