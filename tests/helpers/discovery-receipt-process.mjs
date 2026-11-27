import { once } from 'node:events'
import { openDatabase } from '../../lib/db/bootstrap.ts'
import { createTripDiscoveryComposer } from '../../lib/trips/composer.ts'
import { createTripDiscoverySearch } from '../../lib/trips/discover.ts'
import { createMemorySearchCache } from '../../lib/trips/search-cache.ts'
import { createZhihuSearchClient } from '../../lib/zhihu/client.ts'

const [{ path, tripId, cookie, intentId, at, candidateIds, observations, hold,
  warmAt, fallbackStatus, holdCommit, commitAt }] = await once(process, 'message')
const db = openDatabase(path)
let current = at
const now = () => new Date(current)
let providerCalls = 0
let warmCalls = 0
let reads = 0
let writes = 0
const memory = createMemorySearchCache()
const cache = {
  async read(key) {
    if (db.isTransaction) throw new Error('Unexpected cache read in SQLite transaction')
    reads++
    return memory.read(key)
  },
  async write(key, value) {
    if (db.isTransaction) throw new Error('Unexpected cache write in SQLite transaction')
    writes++
    await memory.write(key, value)
  },
}
const metrics = () => ({ providerCalls, warmCalls, reads, writes })
function successfulResponse() {
  return Response.json({ Code: 0, Data: { Items: candidateIds.map(id => ({
    Title: `受控资料 ${id}`, Url: `https://www.zhihu.com/question/123/answer/${id}`,
    ContentText: '受控摘要', AuthorityLevel: '3', VoteUpCount: 1,
  })) } })
}
try {
  const request = new Request('http://localhost', { headers: { cookie } })
  if (warmAt) {
    current = warmAt
    const warm = createZhihuSearchClient({
      accessSecret: 'controlled-c6-fixture',
      now: () => now().getTime(),
      fetch: async () => { warmCalls++; return successfulResponse() },
    })
    const warmed = await createTripDiscoverySearch(db, warm, { now, cache })(tripId, request, intentId)
    if (!warmed.ok || warmed.proofs.length === 0 || writes !== 1) throw new Error('Controlled cache production failed')
    current = at
  }
  const provider = createZhihuSearchClient({
    accessSecret: 'controlled-c6-fixture',
    now: () => now().getTime(),
    fetch: async () => {
      providerCalls++
      const resume = hold ? once(process, 'message') : null
      if (resume) {
        process.send({ phase: 'searching', pid: process.pid, transaction: db.isTransaction, candidateIds })
        await resume
      }
      return fallbackStatus ? Response.json({}, { status: fallbackStatus }) : successfulResponse()
    },
  })
  const search = createTripDiscoverySearch(db, provider, { now, cache })
  const result = await search(tripId, request, intentId)
  if (!result.ok) throw new Error('Controlled discovery search failed')
  if (holdCommit) {
    const resume = once(process, 'message')
    process.send({ phase: 'selected', pid: process.pid, transaction: db.isTransaction,
      proofCount: result.proofs.length, fetchedAt: result.fetchedAt, degradation: result.degradation, ...metrics() })
    await resume
  }
  current = commitAt ?? at
  const composition = createTripDiscoveryComposer(db, { now })(tripId, request, {
    intentId, searchProofs: result.proofs, observations,
  })
  const receipts = db.prepare('SELECT * FROM trip_discovery_receipt WHERE trip_id=?').all(tripId)
  const count = db.prepare('SELECT count(*) n FROM find WHERE trip_id=?').get(tripId).n
  process.send({ phase: 'done', ...metrics(), composition, receipts, count,
    fetchedAt: result.fetchedAt, degradation: result.degradation })
} catch (error) {
  process.send({ phase: 'done', ...metrics(), error: { code: error.code ?? null, message: error.message } })
} finally {
  db.close()
  process.disconnect()
}
