import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { createTripEventSelector } from '../../lib/events/select.ts'

const { path, input, random, startAt } = workerData
const db = new DatabaseSync(path, { timeout: 5000 })
const pick = createTripEventSelector(db, { now: () => new Date(startAt), random: () => random })
parentPort.postMessage('ready')
parentPort.once('message', () => {
  try {
    parentPort.postMessage(pick(input))
  } finally {
    db.close()
    parentPort.close()
  }
})
