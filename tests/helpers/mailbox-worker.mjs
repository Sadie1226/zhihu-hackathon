import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { markExchangeRead } from '../../lib/mailbox/service.ts'
import { createTripService } from '../../lib/trips/service.ts'

const { path, action, id, sessionId, at } = workerData
const db = new DatabaseSync(path, { timeout: 5000 })
parentPort.postMessage('ready')
parentPort.once('message', () => {
  try {
    const result = action === 'read' ? markExchangeRead(db, id, sessionId) :
      createTripService(db, { now: () => new Date(at) }).start(id, sessionId)
    parentPort.postMessage(result)
  } finally {
    db.close()
    parentPort.close()
  }
})
