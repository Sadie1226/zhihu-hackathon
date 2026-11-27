import { once } from 'node:events'
import { openDatabase } from '../../lib/db/bootstrap.ts'
import { draftFor, request, returns } from './trip-return-fixtures.mjs'

const [{ path, tripId, dogId, cookie, hold }] = await once(process, 'message')
const db = openDatabase(path)
let calls = 0
try {
  const service = returns(db, { generationTimeoutMs: 10000, generate: async input => {
    if (db.isTransaction) throw new Error('Unexpected transaction during generation')
    calls++
    if (hold) {
      const ready = once(process, 'message')
      process.send({ phase: 'generating' })
      await ready
    }
    return draftFor(input)
  } })
  const result = await service.owner({ tripId, dogId, request: request(cookie) })
  process.send({ result, calls })
} finally {
  db.close()
  process.disconnect()
}
