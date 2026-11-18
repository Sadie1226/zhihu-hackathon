import { openDatabase } from '../../lib/db/bootstrap.ts'
import { createTripService } from '../../lib/trips/service.ts'

const db = openDatabase(process.argv[2])
const service = createTripService(db, { now: () => new Date('2026-11-17T00:00:00Z') })
process.send('ready')
process.once('message', () => {
  try { process.send({ status: 'ok', trip: service.create('dog-a', 'session-a', 'auto') }) }
  catch (error) { process.send({ status: error.code ?? error.message }) }
  finally { db.close(); process.disconnect() }
})
