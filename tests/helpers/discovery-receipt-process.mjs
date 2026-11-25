import { once } from 'node:events'
import { openDatabase } from '../../lib/db/bootstrap.ts'
import { createTripDiscoveryComposer } from '../../lib/trips/composer.ts'
import { createTripDiscoverySearch } from '../../lib/trips/discover.ts'
import { createZhihuSearchClient } from '../../lib/zhihu/client.ts'

const [{ path, tripId, cookie, intentId, at, candidateIds, observations, hold }] = await once(process, 'message')
const db = openDatabase(path)
const now = () => new Date(at)
let providerCalls = 0
try {
  const request = new Request('http://localhost', { headers: { cookie } })
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
      return Response.json({ Code: 0, Data: { Items: candidateIds.map(id => ({
        Title: `受控资料 ${id}`, Url: `https://www.zhihu.com/question/123/answer/${id}`,
        ContentText: '受控摘要', AuthorityLevel: '3', VoteUpCount: 1,
      })) } })
    },
  })
  const search = createTripDiscoverySearch(db, provider, { now })
  const result = await search(tripId, request, intentId)
  if (!result.ok) throw new Error('Controlled discovery search failed')
  const composition = createTripDiscoveryComposer(db, { now })(tripId, request, {
    intentId, searchProofs: result.proofs, observations,
  })
  const receipts = db.prepare('SELECT * FROM trip_discovery_receipt WHERE trip_id=?').all(tripId)
  const count = db.prepare('SELECT count(*) n FROM find WHERE trip_id=?').get(tripId).n
  process.send({ phase: 'done', providerCalls, composition, receipts, count })
} catch (error) {
  process.send({ phase: 'done', providerCalls, error: { code: error.code ?? null, message: error.message } })
} finally {
  db.close()
  process.disconnect()
}
